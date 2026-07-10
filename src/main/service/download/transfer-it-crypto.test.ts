import { describe, expect, it } from "vitest";

import {
    TRANSFER_CHUNK_SIZE,
    decryptTransferChunk,
    transferChunkLayoutMatches,
    transferChunkSizes,
} from "./transfer-it-crypto";

describe("decryptTransferChunk", () => {
    it.each([0, 1, 15, 16, 17, 31])("decrypts from arbitrary byte offset %i", (offset) => {
        const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
        const plain = Buffer.from("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
        const encrypted = decryptTransferChunk(key, 0, plain);

        expect(decryptTransferChunk(key, offset, encrypted.subarray(offset))).toEqual(
            plain.subarray(offset),
        );
    });
});

describe("transferChunkSizes", () => {
    it("returns no chunks for empty or invalid sizes", () => {
        expect(transferChunkSizes(0)).toEqual([]);
        expect(transferChunkSizes(-1)).toEqual([]);
        expect(transferChunkSizes(Number.NaN)).toEqual([]);
    });

    it("keeps a single chunk when the file fits in one chunk", () => {
        expect(transferChunkSizes(TRANSFER_CHUNK_SIZE)).toEqual([
            { start: 0, size: TRANSFER_CHUNK_SIZE },
        ]);
        expect(transferChunkSizes(1024)).toEqual([{ start: 0, size: 1024 }]);
    });

    it("splits on a fixed 25MiB boundary with a remainder chunk", () => {
        const fileSize = TRANSFER_CHUNK_SIZE * 2 + 123;
        expect(transferChunkSizes(fileSize)).toEqual([
            { start: 0, size: TRANSFER_CHUNK_SIZE },
            { start: TRANSFER_CHUNK_SIZE, size: TRANSFER_CHUNK_SIZE },
            { start: TRANSFER_CHUNK_SIZE * 2, size: 123 },
        ]);
    });
});

describe("transferChunkLayoutMatches", () => {
    const fileSize = TRANSFER_CHUNK_SIZE * 2 + 123;
    const expected = transferChunkSizes(fileSize);

    it("matches an empty stored set (no conflict)", () => {
        expect(transferChunkLayoutMatches([], expected)).toBe(true);
    });

    it("matches a partial progress subset of the current schedule", () => {
        expect(
            transferChunkLayoutMatches(
                [{ chunkIndex: 0, offset: expected[0]!.start, size: expected[0]!.size }],
                expected,
            ),
        ).toBe(true);
    });

    it("matches when every stored row aligns with the schedule", () => {
        expect(
            transferChunkLayoutMatches(
                expected.map((chunk, chunkIndex) => ({
                    chunkIndex,
                    offset: chunk.start,
                    size: chunk.size,
                })),
                expected,
            ),
        ).toBe(true);
    });

    it("rejects MEGA-style small chunks against the 25MiB schedule", () => {
        expect(
            transferChunkLayoutMatches(
                [
                    { chunkIndex: 0, offset: 0, size: 131_072 },
                    { chunkIndex: 1, offset: 131_072, size: 262_144 },
                ],
                expected,
            ),
        ).toBe(false);
    });

    it("rejects a stored index beyond the expected schedule", () => {
        expect(
            transferChunkLayoutMatches(
                [{ chunkIndex: expected.length, offset: 0, size: TRANSFER_CHUNK_SIZE }],
                expected,
            ),
        ).toBe(false);
    });
});
