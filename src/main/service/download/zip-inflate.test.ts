import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw } from "node:zlib";

import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { getStagingPartPath } from "./part-file";
import { inflateRawFile, zipDeflateProgressScale } from "./zip-inflate";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fse.remove(dir)));
});

async function makeTempDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zip-inflate-"));
    tempDirs.push(dir);
    return dir;
}

async function deflateRawToFile(input: Buffer, outputPath: string) {
    const deflate = createDeflateRaw();
    const output = createWriteStream(outputPath);
    await pipeline([input], deflate, output);
}

describe("zipDeflateProgressScale", () => {
    it("scales compressed download bytes onto the uncompressed file size", () => {
        expect(zipDeflateProgressScale(100, 400)).toEqual({
            sourceTotal: 100,
            displayTotal: 400,
        });
    });
});

describe("inflateRawFile", () => {
    it("inflates a staging payload to the expected uncompressed size", async () => {
        const dir = await makeTempDir();
        const stagingPath = path.join(dir, "file.part.z");
        const outputPath = path.join(dir, "file.part");
        const payload = Buffer.from("hello zip entry payload ".repeat(100));

        await deflateRawToFile(payload, stagingPath);
        await inflateRawFile(stagingPath, outputPath, payload.length);

        expect(await fsp.readFile(outputPath)).toEqual(payload);
        expect(getStagingPartPath(outputPath)).toBe(stagingPath);
    });

    it("reports inflate progress as uncompressed bytes are written", async () => {
        const dir = await makeTempDir();
        const stagingPath = path.join(dir, "file.part.z");
        const outputPath = path.join(dir, "file.part");
        const payload = Buffer.alloc(2 * 1024 * 1024, 7);
        const progress: number[] = [];

        await deflateRawToFile(payload, stagingPath);
        await inflateRawFile(
            stagingPath,
            outputPath,
            payload.length,
            undefined,
            undefined,
            (bytes) => {
                progress.push(bytes);
            },
        );

        expect(progress.at(-1)).toBe(payload.length);
        expect(progress.length).toBeGreaterThan(1);
    });

    it("aborts inflate when the signal is aborted", async () => {
        const dir = await makeTempDir();
        const stagingPath = path.join(dir, "file.part.z");
        const outputPath = path.join(dir, "file.part");
        const payload = Buffer.alloc(2 * 1024 * 1024, 7);
        const controller = new AbortController();

        await deflateRawToFile(payload, stagingPath);
        controller.abort();

        await expect(
            inflateRawFile(stagingPath, outputPath, payload.length, undefined, controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(await fse.pathExists(outputPath)).toBe(false);
    });
});
