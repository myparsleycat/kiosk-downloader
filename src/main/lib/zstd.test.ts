import { describe, expect, it } from "vitest";

import { compressZstd, compressZstdSync, decompressZstd, decompressZstdSync } from "./zstd";

describe("zstd", () => {
    it("round-trips sync and async", async () => {
        const payload = Buffer.from("kiosk-download-collection");

        expect(decompressZstdSync(compressZstdSync(payload)).equals(payload)).toBe(true);
        expect((await decompressZstd(await compressZstd(payload))).equals(payload)).toBe(true);
    });

    it("rejects decompressed output larger than the configured limit", async () => {
        const compressed = compressZstdSync(Buffer.alloc(1024));

        expect(() => decompressZstdSync(compressed, { maxOutputLength: 32 })).toThrow();
        await expect(decompressZstd(compressed, { maxOutputLength: 32 })).rejects.toThrow();
    });
});
