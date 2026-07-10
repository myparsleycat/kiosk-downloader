import { describe, expect, it } from "vitest";

import { decryptTransferChunk } from "./transfer-it-crypto";

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
