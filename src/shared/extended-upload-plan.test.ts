import { describe, expect, it } from "vitest";

import {
    createExtendedUploadPlan,
    EXTENDED_UPLOAD_DEFAULT_LIMITS,
    packSizedItems,
    type ExtendedUploadSourceFile,
} from "./extended-upload-plan";

const GiB = 1024 ** 3;

function file(path: string, size: number): ExtendedUploadSourceFile {
    return { path, name: path.split("/").at(-1) ?? path, size, sourceMtimeMs: 1_700_000_000_000 };
}

describe("extended upload planning", () => {
    it("keeps the exact file-count and byte boundaries in one collection", () => {
        const commonSize = Math.floor((50 * GiB) / 1_000);
        const result = createExtendedUploadPlan(
            Array.from({ length: 1_000 }, (_, index) =>
                file(`${index}.bin`, index === 999 ? 50 * GiB - commonSize * 999 : commonSize),
            ),
            "integrated",
        );

        expect(result.ok).toBe(true);
        expect(result.collections).toHaveLength(1);
        expect(result.collections[0]).toMatchObject({
            totalSize: EXTENDED_UPLOAD_DEFAULT_LIMITS.maxBytes,
        });
        expect(result.collections[0]?.pieces).toHaveLength(1_000);
    });

    it("starts new collections immediately beyond either exact boundary", () => {
        const overCount = createExtendedUploadPlan(
            Array.from({ length: 1_001 }, (_, index) => file(`${index}.txt`, 0)),
            "compatible",
        );
        const overBytes = createExtendedUploadPlan(
            [file("full.bin", 50 * GiB), file("extra.bin", 1)],
            "compatible",
        );

        expect(overCount.collections.map((collection) => collection.pieces.length)).toEqual([
            1_000, 1,
        ]);
        expect(overBytes.collections.map((collection) => collection.totalSize)).toEqual([
            50 * GiB,
            1,
        ]);
    });

    it("splits a 120 GiB file while preserving its source ranges", () => {
        const result = createExtendedUploadPlan(
            [file("video/archive.mkv", 120 * GiB)],
            "integrated",
        );

        expect(result.ok).toBe(true);
        expect(result.collections).toHaveLength(3);
        expect(result.collections.flatMap((collection) => collection.pieces)).toEqual([
            expect.objectContaining({
                sourcePath: "video/archive.mkv",
                offset: 0,
                length: 50 * GiB,
                pieceIndex: 0,
                pieceCount: 3,
            }),
            expect.objectContaining({
                sourcePath: "video/archive.mkv",
                offset: 50 * GiB,
                length: 50 * GiB,
                pieceIndex: 1,
                pieceCount: 3,
            }),
            expect.objectContaining({
                sourcePath: "video/archive.mkv",
                offset: 100 * GiB,
                length: 20 * GiB,
                pieceIndex: 2,
                pieceCount: 3,
            }),
        ]);
    });

    it("packs smaller files into the best fitting collection", () => {
        const result = createExtendedUploadPlan(
            [file("large.bin", 120 * GiB), file("thirty.bin", 30 * GiB)],
            "integrated",
        );

        expect(result.collections.map((collection) => collection.totalSize)).toEqual([
            50 * GiB,
            50 * GiB,
            50 * GiB,
        ]);
        expect(result.collections[2]?.pieces.map((piece) => piece.sourcePath)).toEqual([
            "thirty.bin",
            "large.bin",
        ]);
    });

    it("returns compatible-mode oversized files without splitting or making a partial plan", () => {
        const oversized = file("huge.iso", 50 * GiB + 1);
        const result = createExtendedUploadPlan([file("small.txt", 10), oversized], "compatible");

        expect(result).toEqual({
            ok: false,
            mode: "compatible",
            collections: [],
            oversizedFiles: [oversized],
        });
    });

    it("counts zero-byte files as pieces", () => {
        const result = createExtendedUploadPlan(
            [file("empty-a", 0), file("empty-b", 0)],
            "integrated",
            { maxFiles: 1, maxBytes: 10 },
        );

        expect(result.collections).toHaveLength(2);
        expect(result.collections.flatMap((collection) => collection.pieces)).toEqual([
            expect.objectContaining({ sourcePath: "empty-a", offset: 0, length: 0 }),
            expect.objectContaining({ sourcePath: "empty-b", offset: 0, length: 0 }),
        ]);
    });

    it("produces the same plan deterministically", () => {
        const files = [file("z.bin", 6), file("a.bin", 6), file("c.bin", 4), file("b.bin", 4)];
        const first = createExtendedUploadPlan(files, "integrated", {
            maxFiles: 3,
            maxBytes: 10,
        });

        expect(first).toEqual(
            createExtendedUploadPlan(files, "integrated", { maxFiles: 3, maxBytes: 10 }),
        );
        expect(
            first.collections.map((collection) =>
                collection.pieces.map((piece) => piece.sourcePath),
            ),
        ).toEqual([
            ["a.bin", "b.bin"],
            ["z.bin", "c.bin"],
        ]);
    });

    it("breaks remaining-capacity ties with the lowest collection index", () => {
        const collections = packSizedItems(
            [
                { id: "a", size: 5, sortKey: "a" },
                { id: "b", size: 5, sortKey: "b" },
                { id: "c", size: 5, sortKey: "c" },
            ],
            { maxFiles: 10, maxBytes: 10 },
        );

        expect(collections.map((collection) => collection.items.map((item) => item.id))).toEqual([
            ["a", "b"],
            ["c"],
        ]);
    });
});
