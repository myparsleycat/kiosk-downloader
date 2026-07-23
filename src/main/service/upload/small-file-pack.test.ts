import path from "node:path";

import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import {
    createSmallFilePackPlan,
    materializeSmallFilePack,
    SMALL_FILE_PACK_BYTES,
    type PersistedBundleFile,
} from "./small-file-pack";

const testDirs: string[] = [];

afterEach(async () => {
    await Promise.all(testDirs.splice(0).map((dir) => fse.remove(dir)));
});

function source(name: string, size: number): PersistedBundleFile {
    return {
        path: name,
        name,
        size,
        fsPath: `/source/${name}`,
        sourceMtimeMs: 1,
        logicalPath: name,
        logicalSize: size,
    };
}

describe("small file packs", () => {
    it("combines whole small files up to the 100 MiB boundary", () => {
        const plan = createSmallFilePackPlan(
            {
                collections: [
                    {
                        files: [
                            source("a", 40 * 1024 ** 2),
                            source("b", 60 * 1024 ** 2),
                            source("c", 1),
                        ],
                    },
                ],
            },
            "bundle-id",
            "/packs",
        );

        expect(plan.collections[0].files).toHaveLength(2);
        expect(plan.collections[0].files[0]).toMatchObject({
            size: SMALL_FILE_PACK_BYTES,
            packEntries: [
                { path: "a", remoteOffset: 0 },
                { path: "b", remoteOffset: 40 * 1024 ** 2 },
            ],
        });
        expect(plan.collections[0].files[1]).toMatchObject({ path: "c", size: 1 });
    });

    it("keeps split pieces and files larger than the target as direct uploads", () => {
        const split = { ...source("large.part", 50), logicalPath: "large", logicalSize: 100 };
        const large = source("large-direct", SMALL_FILE_PACK_BYTES + 1);
        const plan = createSmallFilePackPlan(
            { collections: [{ files: [split, large] }] },
            "bundle-id",
            "/packs",
        );

        expect(plan.collections[0].files).toEqual([split, large]);
    });

    it("materializes source files in manifest offset order", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".pack-test-"));
        testDirs.push(dir);
        const firstPath = path.join(dir, "first");
        const secondPath = path.join(dir, "second");
        await fse.writeFile(firstPath, "first");
        await fse.writeFile(secondPath, "SECOND");
        const firstStat = await fse.stat(firstPath);
        const secondStat = await fse.stat(secondPath);
        const packPath = path.join(dir, "packs", "0.pack");

        const materialized = await materializeSmallFilePack({
            path: "pack/0",
            name: "0",
            size: 11,
            fsPath: packPath,
            sourceMtimeMs: 0,
            logicalPath: "pack/0",
            logicalSize: 11,
            packEntries: [
                {
                    fsPath: firstPath,
                    sourceMtimeMs: Math.trunc(firstStat.mtimeMs),
                    path: "first.txt",
                    size: 5,
                    remoteOffset: 0,
                },
                {
                    fsPath: secondPath,
                    sourceMtimeMs: Math.trunc(secondStat.mtimeMs),
                    path: "second.txt",
                    size: 6,
                    remoteOffset: 5,
                },
            ],
        });

        expect(await fse.readFile(packPath, "utf8")).toBe("firstSECOND");
        expect(materialized.sourceMtimeMs).toBeGreaterThan(0);
    });
});
