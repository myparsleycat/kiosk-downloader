import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";

import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { PartFileWriter } from "./part-file";

async function* bytesFrom(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) {
        yield chunk;
    }
}

describe("PartFileWriter.writeChunkFromStream resume", () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => fse.remove(dir)));
    });

    it("produces the same digest for full write and resumed write", async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "part-file-"));
        tempDirs.push(dir);

        const payload = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789");
        const fullPath = path.join(dir, "full.part");
        const resumePath = path.join(dir, "resume.part");

        const fullWriter = new PartFileWriter(fullPath);
        await fullWriter.open(payload.length, 1);
        const fullWritten = await fullWriter.writeChunkFromStream(
            0,
            0,
            bytesFrom([payload]),
            payload.length,
            8,
        );
        await fullWriter.close();

        const splitAt = 10;
        await fse.writeFile(resumePath, payload.subarray(0, splitAt));
        const resumeWriter = new PartFileWriter(resumePath);
        await resumeWriter.open(payload.length, 1);
        const resumeWritten = await resumeWriter.writeChunkFromStream(
            0,
            0,
            bytesFrom([payload.subarray(splitAt)]),
            payload.length,
            8,
            undefined,
            { alreadyWritten: splitAt },
        );
        await resumeWriter.close();

        expect(fullWritten).toBe(payload.length);
        expect(resumeWritten).toBe(payload.length);
        expect(await fse.readFile(resumePath)).toEqual(payload);
        expect(await fse.readFile(`${resumePath}.crc`)).toEqual(
            await fse.readFile(`${fullPath}.crc`),
        );

        const expectedCrc = Buffer.alloc(4);
        expectedCrc.writeUInt32BE(crc32(payload) >>> 0, 0);
        expect(await fse.readFile(`${resumePath}.crc`)).toEqual(expectedCrc);

        await expect(
            PartFileWriter.isChunkValid(resumePath, {
                chunkIndex: 0,
                offset: 0,
                size: payload.length,
            }),
        ).resolves.toBe(true);
    });

    it("reports committed progress including the existing prefix", async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "part-file-"));
        tempDirs.push(dir);

        const payload = Buffer.from("abcdefghijklmnopqrst");
        const splitAt = 8;
        const partPath = path.join(dir, "resume.part");
        await fse.writeFile(partPath, payload.subarray(0, splitAt));

        const writeProgress: number[] = [];
        const writer = new PartFileWriter(partPath);
        await writer.open(payload.length, 1);
        await writer.writeChunkFromStream(
            0,
            0,
            bytesFrom([payload.subarray(splitAt)]),
            payload.length,
            4,
            { onWriteProgress: (bytes) => writeProgress.push(bytes) },
            { alreadyWritten: splitAt },
        );
        await writer.close();

        expect(writeProgress).toEqual([12, 16, 20]);
        expect(await fse.readFile(partPath)).toEqual(payload);
    });

    it("does not commit a partial pending batch when the source fails", async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "part-file-"));
        tempDirs.push(dir);

        const prefix = Buffer.from("abcdefgh");
        const partPath = path.join(dir, "resume.part");
        await fse.writeFile(partPath, prefix);

        async function* failingSource() {
            yield Buffer.from("ijk");
            throw new Error("connection lost");
        }

        const writeProgress: number[] = [];
        const writer = new PartFileWriter(partPath);
        await writer.open(16, 1);
        await expect(
            writer.writeChunkFromStream(
                0,
                0,
                failingSource(),
                16,
                4,
                {
                    onWriteProgress: (bytes) => writeProgress.push(bytes),
                },
                { alreadyWritten: prefix.length },
            ),
        ).rejects.toThrow("connection lost");
        await writer.close();

        expect(writeProgress).toEqual([]);
        expect(await fse.readFile(partPath)).toEqual(prefix);
    });

    it("rejects a resume offset beyond the available part-file prefix", async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "part-file-"));
        tempDirs.push(dir);

        const partPath = path.join(dir, "resume.part");
        await fse.writeFile(partPath, Buffer.from("abcd"));

        const writer = new PartFileWriter(partPath);
        await writer.open(12, 1);
        await expect(
            writer.writeChunkFromStream(0, 0, bytesFrom([Buffer.from("ijkl")]), 12, 4, undefined, {
                alreadyWritten: 8,
            }),
        ).rejects.toThrow("Part file is shorter than resume offset");
        await writer.close();
    });

    it("rebuilds the digest without opening the source when the payload is fully written", async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "part-file-"));
        tempDirs.push(dir);

        const payload = Buffer.from("fully-written-payload");
        const partPath = path.join(dir, "resume.part");
        await fse.writeFile(partPath, payload);
        let sourceOpened = false;
        async function* unexpectedSource() {
            sourceOpened = true;
            yield Buffer.alloc(0);
        }

        const writer = new PartFileWriter(partPath);
        await writer.open(payload.length, 1);
        await expect(
            writer.writeChunkFromStream(0, 0, unexpectedSource(), payload.length, 4, undefined, {
                alreadyWritten: payload.length,
            }),
        ).resolves.toBe(payload.length);
        await writer.close();

        expect(sourceOpened).toBe(false);
        await expect(
            PartFileWriter.isChunkValid(partPath, {
                chunkIndex: 0,
                offset: 0,
                size: payload.length,
            }),
        ).resolves.toBe(true);
    });
});
