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
});
