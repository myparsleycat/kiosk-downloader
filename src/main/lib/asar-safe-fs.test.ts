import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    isAsarPath,
    moveFileOverwrite,
    pathExists,
    statOrNull,
    writeEmptyFile,
} from "./asar-safe-fs";

describe("asar-safe-fs", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "asar-safe-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("detects .asar path segments only", () => {
        expect(isAsarPath("D:\\game\\resources\\app.asar")).toBe(true);
        expect(isAsarPath("/game/resources/default_app.ASAR")).toBe(true);
        expect(isAsarPath("/game/x.asar/inner.txt")).toBe(true);
        expect(isAsarPath("/game/resources/app.asar.part")).toBe(false);
        expect(isAsarPath("/game/notasar.txt")).toBe(false);
    });

    it("moves a part file onto an .asar name and overwrites an existing one", async () => {
        const part = path.join(dir, "resources", "app.asar.part");
        const dest = path.join(dir, "resources", "app.asar");
        fs.mkdirSync(path.dirname(part), { recursive: true });
        fs.writeFileSync(part, Buffer.alloc(4096, 7));

        await moveFileOverwrite(part, dest);
        expect((await statOrNull(dest))?.size).toBe(4096);
        expect(await pathExists(part)).toBe(false);

        fs.writeFileSync(part, Buffer.alloc(10, 1));
        await moveFileOverwrite(part, dest);
        expect((await statOrNull(dest))?.size).toBe(10);
        expect(process.noAsar).toBeFalsy();
    });

    it("creates parent directories for normal and .asar destinations", async () => {
        const src = path.join(dir, "a.txt.part");
        fs.writeFileSync(src, "hi");
        await moveFileOverwrite(src, path.join(dir, "nested", "a.txt"));
        expect(fs.readFileSync(path.join(dir, "nested", "a.txt"), "utf8")).toBe("hi");

        const empty = path.join(dir, "deep", "default_app.asar");
        await writeEmptyFile(empty);
        expect((await statOrNull(empty))?.size).toBe(0);
    });

    it("returns null for missing paths", async () => {
        expect(await statOrNull(path.join(dir, "missing.asar"))).toBeNull();
        expect(await pathExists(path.join(dir, "missing.txt"))).toBe(false);
    });
});
