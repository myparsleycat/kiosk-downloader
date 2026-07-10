import { describe, expect, it } from "vitest";

import {
    buildZipEntrySegmentChunks,
    computeStoredDataOffset,
    mapAbsoluteRangeToSegments,
    readUint16LE,
    supportsZipEntryPoolDownload,
} from "./zip-segment-map";

describe("mapAbsoluteRangeToSegments", () => {
    it("maps a range inside a single segment", () => {
        expect(mapAbsoluteRangeToSegments(100, 50, 1024, 4096)).toEqual([
            { segmentIndex: 0, localStart: 100, localEnd: 150, length: 50 },
        ]);
    });

    it("splits ranges across segment boundaries", () => {
        expect(mapAbsoluteRangeToSegments(1000, 50, 1024, 4096)).toEqual([
            { segmentIndex: 0, localStart: 1000, localEnd: 1024, length: 24 },
            { segmentIndex: 1, localStart: 0, localEnd: 26, length: 26 },
        ]);
    });

    it("clamps to file size", () => {
        expect(mapAbsoluteRangeToSegments(4000, 200, 1024, 4096)).toEqual([
            { segmentIndex: 3, localStart: 928, localEnd: 1024, length: 96 },
        ]);
    });
});

describe("computeStoredDataOffset", () => {
    it("reads local header name/extra lengths", () => {
        const fields = new Uint8Array([3, 0, 2, 0]);
        expect(readUint16LE(fields, 0)).toBe(3);
        expect(readUint16LE(fields, 2)).toBe(2);
        expect(computeStoredDataOffset(100, fields)).toBe(135);
    });
});

describe("buildZipEntrySegmentChunks", () => {
    it("builds sequential part offsets across segment spans", () => {
        const chunks = buildZipEntrySegmentChunks(1000, 50, 1024, 4096);
        expect(chunks).toEqual([
            {
                chunkIndex: 0,
                offset: 0,
                size: 24,
                segmentIndex: 0,
                localStart: 1000,
                localEnd: 1024,
            },
            {
                chunkIndex: 1,
                offset: 24,
                size: 26,
                segmentIndex: 1,
                localStart: 0,
                localEnd: 26,
            },
        ]);
        expect(chunks.reduce((sum, chunk) => sum + chunk.size, 0)).toBe(50);
    });

    it("keeps chunkIndex independent from segmentIndex", () => {
        const chunks = buildZipEntrySegmentChunks(2048 + 10, 20, 1024, 8192);
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.chunkIndex).toBe(0);
        expect(chunks[0]?.segmentIndex).toBe(2);
    });
});

describe("supportsZipEntryPoolDownload", () => {
    it("allows stored and deflate without encryption", () => {
        expect(
            supportsZipEntryPoolDownload({
                encrypted: false,
                compressionMethod: 0,
                compressedSize: 10,
                uncompressedSize: 10,
            }),
        ).toBe(true);
        expect(
            supportsZipEntryPoolDownload({
                encrypted: false,
                compressionMethod: 8,
                compressedSize: 4,
                uncompressedSize: 10,
            }),
        ).toBe(true);
    });

    it("rejects encrypted, empty, mismatched stored, and unknown methods", () => {
        expect(
            supportsZipEntryPoolDownload({
                encrypted: true,
                compressionMethod: 8,
                compressedSize: 4,
                uncompressedSize: 10,
            }),
        ).toBe(false);
        expect(
            supportsZipEntryPoolDownload({
                encrypted: false,
                compressionMethod: 8,
                compressedSize: 0,
                uncompressedSize: 10,
            }),
        ).toBe(false);
        expect(
            supportsZipEntryPoolDownload({
                encrypted: false,
                compressionMethod: 0,
                compressedSize: 4,
                uncompressedSize: 10,
            }),
        ).toBe(false);
        expect(
            supportsZipEntryPoolDownload({
                encrypted: false,
                compressionMethod: 12,
                compressedSize: 4,
                uncompressedSize: 10,
            }),
        ).toBe(false);
    });
});
