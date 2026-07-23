import { createHash } from "node:crypto";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import {
    createDeterministicPackArtifacts,
    createSmallFilePackPlan,
    materializeSmallFilePack,
    SMALL_FILE_PACK_BYTES,
    SMALL_FILE_PACK_ENTRY_MAX_BYTES,
    type PersistedBundleFile,
} from "./small-file-pack";

const testDirs: string[] = [];

afterEach(async () => {
    await Promise.all(testDirs.splice(0).map((dir) => fse.remove(dir)));
});

function source(
    name: string,
    size: number,
    contentSha256 = createHash("sha256").update(name).digest("hex"),
): PersistedBundleFile {
    return {
        path: name,
        name,
        size,
        fsPath: `/source/${name}`,
        sourceMtimeMs: 1,
        logicalPath: name,
        logicalSize: size,
        logicalSha256: contentSha256,
    };
}

describe("small file packs", () => {
    it("packs whole files under the entry threshold by content hash order", () => {
        const a = source("a", 4 * 1024 ** 2);
        const b = source("b", 5 * 1024 ** 2);
        const c = source("c", 1);
        const artifacts = createDeterministicPackArtifacts([c, b, a], "/packs");

        const pack = artifacts.find((file) => file.packEntries);
        expect(pack).toMatchObject({
            size: a.size + b.size + c.size,
            path: expect.stringMatching(/^kde_pack_v2\/[0-9a-f]{64}$/),
        });
        expect(pack?.packEntries?.map((entry) => entry.path).toSorted()).toEqual(["a", "b", "c"]);
        expect(pack?.packEntries?.every((entry) => entry.contentSha256)).toBe(true);
    });

    it("ignores path renames for pack membership and recipe id", () => {
        const hashA = createHash("sha256").update("A").digest("hex");
        const hashB = createHash("sha256").update("B").digest("hex");
        const first = createDeterministicPackArtifacts(
            [source("docs/a.txt", 10, hashA), source("docs/b.txt", 20, hashB)],
            "/packs",
        );
        const second = createDeterministicPackArtifacts(
            [source("other/b.txt", 20, hashB), source("renamed/a.txt", 10, hashA)],
            "/packs",
        );

        expect(first.find((file) => file.packEntries)?.path).toBe(
            second.find((file) => file.packEntries)?.path,
        );
        expect(
            first.find((file) => file.packEntries)?.packEntries?.map((entry) => entry.size),
        ).toEqual(second.find((file) => file.packEntries)?.packEntries?.map((entry) => entry.size));
    });

    it("keeps split pieces and files at or above the entry threshold as direct uploads", () => {
        const split = {
            ...source("large.part", 50),
            logicalPath: "large",
            logicalSize: 100,
            logicalSha256: undefined,
        };
        const large = source("large-direct", SMALL_FILE_PACK_ENTRY_MAX_BYTES);
        const overPackCap = source("old-threshold", SMALL_FILE_PACK_BYTES + 1);
        const artifacts = createDeterministicPackArtifacts([split, large, overPackCap], "/packs");

        expect(artifacts).toEqual([split, large, overPackCap]);
    });

    it("does not pack a single eligible file alone", () => {
        const only = source("solo.bin", 100);
        expect(createDeterministicPackArtifacts([only], "/packs")).toEqual([only]);
    });

    it("produces identical packs when input order is shuffled", () => {
        const files = [
            source("z", 3 * 1024 ** 2),
            source("a", 2 * 1024 ** 2),
            source("m", 4 * 1024 ** 2),
            source("b", 1 * 1024 ** 2),
        ];
        const left = createDeterministicPackArtifacts(files, "/packs");
        const right = createDeterministicPackArtifacts([...files].reverse(), "/packs");

        expect(left.map((file) => file.path)).toEqual(right.map((file) => file.path));
        expect(
            left.map((file) => file.packEntries?.map((entry) => entry.contentSha256) ?? null),
        ).toEqual(
            right.map((file) => file.packEntries?.map((entry) => entry.contentSha256) ?? null),
        );
    });

    it("preserves legacy collection-local packing for v1 resume", () => {
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

    it("materializes source files in manifest offset order and checks content hash", async () => {
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
                    contentSha256: createHash("sha256").update("first").digest("hex"),
                },
                {
                    fsPath: secondPath,
                    sourceMtimeMs: Math.trunc(secondStat.mtimeMs),
                    path: "second.txt",
                    size: 6,
                    remoteOffset: 5,
                    contentSha256: createHash("sha256").update("SECOND").digest("hex"),
                },
            ],
        });

        expect(await fse.readFile(packPath, "utf8")).toBe("firstSECOND");
        expect(materialized.sourceMtimeMs).toBeGreaterThan(0);
    });

    it("rejects materialization when content hash mismatches", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".pack-test-"));
        testDirs.push(dir);
        const firstPath = path.join(dir, "first");
        await fse.writeFile(firstPath, "first");
        const firstStat = await fse.stat(firstPath);

        await expect(
            materializeSmallFilePack({
                path: "pack/0",
                name: "0",
                size: 5,
                fsPath: path.join(dir, "bad.pack"),
                sourceMtimeMs: 0,
                packEntries: [
                    {
                        fsPath: firstPath,
                        sourceMtimeMs: Math.trunc(firstStat.mtimeMs),
                        path: "first.txt",
                        size: 5,
                        remoteOffset: 0,
                        contentSha256: createHash("sha256").update("other").digest("hex"),
                    },
                ],
            }),
        ).rejects.toThrow("업로드 원본 파일 내용이 변경되었습니다");
    });
});
