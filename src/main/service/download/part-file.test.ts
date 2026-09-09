import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";

import fse from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PartFileWriter } from "./part-file";

type PartWriterInternals = {
    handle: {
        write: (
            buffer: Uint8Array,
            offset: number,
            length: number,
            position: number,
        ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;
    };
};

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

    it("fills short writes before saving a resumable prefix even when a later chunk exists", async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "part-file-"));
        tempDirs.push(dir);
        const partPath = path.join(dir, "resume.part");
        const writer = new PartFileWriter(partPath);
        await writer.open(12, 2);
        const handle = (writer as unknown as PartWriterInternals).handle;
        const write = handle.write.bind(handle);
        const progress: number[] = [];
        try {
            await writer.writeChunkFromStream(8, 1, bytesFrom([Buffer.from("tail")]), 4, 4);
            vi.spyOn(handle, "write").mockImplementationOnce(async () =>
                write(Buffer.from("abcd"), 0, 2, 0),
            );
            async function* interruptedSource() {
                yield Buffer.from("abcd");
                throw new Error("connection lost");
            }
            await expect(
                writer.writeChunkFromStream(0, 0, interruptedSource(), 8, 4, {
                    onWriteProgress: (bytes) => progress.push(bytes),
                }),
            ).rejects.toThrow("connection lost");
            expect(progress).toEqual([4]);
            expect((await fse.readFile(partPath)).subarray(0, 4)).toEqual(Buffer.from("abcd"));
            await writer.writeChunkFromStream(
                0,
                0,
                bytesFrom([Buffer.from("efgh")]),
                8,
                4,
                undefined,
                { alreadyWritten: progress[0] },
            );
            expect(await fse.readFile(partPath)).toEqual(Buffer.from("abcdefghtail"));
        } finally {
            vi.restoreAllMocks();
            await writer.close();
        }
    });

    it("does not save progress when a short write is followed by a zero-byte write", async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "part-file-"));
        tempDirs.push(dir);
        const writer = new PartFileWriter(path.join(dir, "resume.part"));
        await writer.open(4, 1);
        const handle = (writer as unknown as PartWriterInternals).handle;
        const write = handle.write.bind(handle);
        const payload = Buffer.from("abcd");
        const onWriteProgress = vi.fn();
        try {
            vi.spyOn(handle, "write")
                .mockImplementationOnce(async () => write(payload, 0, 2, 0))
                .mockResolvedValueOnce({ bytesWritten: 0, buffer: payload });
            await expect(
                writer.writeChunkFromStream(0, 0, bytesFrom([payload]), 4, 4, { onWriteProgress }),
            ).rejects.toThrow("Part file write made no progress at 2.");
            expect(onWriteProgress).not.toHaveBeenCalled();
        } finally {
            vi.restoreAllMocks();
            await writer.close();
        }
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

    it("lets the source generator finish after the expected bytes arrive", async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "part-file-"));
        tempDirs.push(dir);

        const payload = Buffer.from("exactly-enough");
        const partPath = path.join(dir, "complete.part");
        let finished = false;
        async function* source() {
            yield payload;
            finished = true;
        }

        const writer = new PartFileWriter(partPath);
        await writer.open(payload.length, 1);
        await expect(writer.writeChunkFromStream(0, 0, source(), payload.length, 8)).resolves.toBe(
            payload.length,
        );
        await writer.close();

        expect(finished).toBe(true);
        expect(await fse.readFile(partPath)).toEqual(payload);
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
