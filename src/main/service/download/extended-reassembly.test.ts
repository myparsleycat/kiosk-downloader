import { createHash } from "node:crypto";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { reassembleExtendedFile } from "./extended-reassembly";

const testDirs: string[] = [];

afterEach(async () => {
    await Promise.all(testDirs.splice(0).map((dir) => fse.remove(dir)));
});

describe("reassembleExtendedFile", () => {
    it("joins ordered pieces and atomically publishes a verified file", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".reassembly-test-"));
        testDirs.push(dir);
        const pieces = [Buffer.from("hello "), Buffer.from("extended upload")];
        const piecePaths = [path.join(dir, "0"), path.join(dir, "1")];
        await Promise.all(
            piecePaths.map((piecePath, index) => fse.writeFile(piecePath, pieces[index])),
        );
        const expected = Buffer.concat(pieces);
        const finalPath = path.join(dir, "output", "result.bin");

        await reassembleExtendedFile({
            pieces: piecePaths.map((piecePath, index) => ({
                path: piecePath,
                offset: index === 0 ? 0 : pieces[0].length,
                size: pieces[index].length,
            })),
            partPath: path.join(dir, "staging", "result.part"),
            finalPath,
            expectedSize: expected.length,
            expectedSha256: createHash("sha256").update(expected).digest("hex"),
        });

        expect(await fse.readFile(finalPath)).toEqual(expected);
    });

    it("removes a corrupt partial result instead of publishing it", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".reassembly-test-"));
        testDirs.push(dir);
        const piecePath = path.join(dir, "piece");
        const partPath = path.join(dir, "staging", "result.part");
        const finalPath = path.join(dir, "output", "result.bin");
        await fse.writeFile(piecePath, "corrupt");

        await expect(
            reassembleExtendedFile({
                pieces: [{ path: piecePath, offset: 0, size: 7 }],
                partPath,
                finalPath,
                expectedSize: 7,
                expectedSha256: "0".repeat(64),
            }),
        ).rejects.toThrow("해시");
        expect(await fse.pathExists(partPath)).toBe(false);
        expect(await fse.pathExists(finalPath)).toBe(false);
    });

    it("reports a clear error when a piece file is missing", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".reassembly-test-"));
        testDirs.push(dir);

        await expect(
            reassembleExtendedFile({
                pieces: [{ path: path.join(dir, "missing"), offset: 0, size: 4 }],
                partPath: path.join(dir, "staging", "result.part"),
                finalPath: path.join(dir, "output", "result.bin"),
                expectedSize: 4,
            }),
        ).rejects.toThrow("준비되지 않았습니다");
    });

    it("publishes a verified zero-byte internally renamed file", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".reassembly-test-"));
        testDirs.push(dir);
        const piecePath = path.join(dir, "piece");
        const finalPath = path.join(dir, "output", "question?.txt");
        await fse.writeFile(piecePath, "");

        await reassembleExtendedFile({
            pieces: [{ path: piecePath, offset: 0, size: 0 }],
            partPath: path.join(dir, "staging", "result.part"),
            finalPath,
            expectedSize: 0,
            expectedSha256: createHash("sha256").update("").digest("hex"),
        });

        expect((await fse.stat(finalPath)).size).toBe(0);
    });

    it("extracts only the requested range from a shared pack file", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".reassembly-test-"));
        testDirs.push(dir);
        const packPath = path.join(dir, "pack");
        const finalPath = path.join(dir, "output", "second.txt");
        await fse.writeFile(packPath, "firstSECONDthird");

        await reassembleExtendedFile({
            pieces: [{ path: packPath, offset: 0, sourceOffset: 5, size: 6 }],
            partPath: path.join(dir, "staging", "result.part"),
            finalPath,
            expectedSize: 6,
        });

        expect(await fse.readFile(finalPath, "utf8")).toBe("SECOND");
    });
});
