import { describe, expect, it } from "vitest";

import {
    SHARE_HOST,
    TRANSFER_HOST,
    buildShareUrl,
    buildTransferUrl,
    shareIdToUuidBytes,
    tryDecodeShareUrlBase64,
    tryExtractShareId,
    tryExtractTransferId,
    tryParseDownloadUrl,
    tryParseShareUrl,
    tryParseTransferUrl,
    uuidBytesToShareId,
} from "./share-url";

// 22 base64url chars carry 132 bits; a UUID is 128. The top 4 bits of the
// first character are discarded on encode, so a UUID-derived share id always
// starts in the first 16-char alphabet range ('a'-'p'). The bytes→id→bytes
// direction round-trips exactly for every input.
const SAMPLE_BYTES = Uint8Array.from([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
]);

describe("share-id / uuid codec", () => {
    it("encodes all-zero bytes as 22 'a' characters and decodes back", () => {
        expect(uuidBytesToShareId(new Uint8Array(16))).toBe("aaaaaaaaaaaaaaaaaaaaaa");
        expect(shareIdToUuidBytes("aaaaaaaaaaaaaaaaaaaaaa")).toEqual(new Uint8Array(16));
    });

    it("maps the low bit of byte 0 onto the last character", () => {
        const bytes = new Uint8Array(16);
        bytes[0] = 0b0000_0001;
        expect(uuidBytesToShareId(bytes)).toBe("aaaaaaaaaaaaaaaaaaaaab");
        expect(shareIdToUuidBytes("aaaaaaaaaaaaaaaaaaaaab")).toEqual(bytes);
    });

    it("round-trips bytes → share-id → bytes for arbitrary inputs", () => {
        for (let seed = 0; seed < 256; seed += 1) {
            const bytes = new Uint8Array(16);
            for (let i = 0; i < 16; i += 1) {
                bytes[i] = (seed * 31 + i * 7) & 0xff;
            }
            const shareId = uuidBytesToShareId(bytes);
            expect(shareId).toHaveLength(22);
            expect(shareIdToUuidBytes(shareId)).toEqual(bytes);
        }
    });

    it("round-trips a realistic UUID-derived share id end-to-end", () => {
        const shareId = uuidBytesToShareId(SAMPLE_BYTES);
        expect(shareIdToUuidBytes(shareId)).toEqual(SAMPLE_BYTES);
    });

    it("rejects share ids of the wrong length", () => {
        expect(() => shareIdToUuidBytes("short")).toThrow("Invalid share id length");
        expect(() => shareIdToUuidBytes("aaaaaaaaaaaaaaaaaaaaaaa")).toThrow(
            "Invalid share id length",
        );
    });

    it("rejects share ids with characters outside the base64url alphabet", () => {
        const invalid = "aaaaaaaaaaaaaaaaaaaaa!".split("");
        invalid[21] = "!";
        expect(() => shareIdToUuidBytes(invalid.join(""))).toThrow('Invalid character "!"');
    });

    it("rejects byte arrays that are not 16 bytes", () => {
        expect(() => uuidBytesToShareId(new Uint8Array(15))).toThrow("Invalid UUID byte length");
        expect(() => uuidBytesToShareId(new Uint8Array(17))).toThrow("Invalid UUID byte length");
    });
});

describe("tryExtractShareId", () => {
    it("extracts the share id from a canonical kio.ac URL", () => {
        expect(tryExtractShareId("https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa")).toBe(
            "aaaaaaaaaaaaaaaaaaaaaa",
        );
    });

    it("accepts the www subdomain and ignores trailing path or query", () => {
        expect(tryExtractShareId("https://www.kio.ac/c/bbbbbbbbbbbbbbbbbbbbbb/sub")).toBe(
            "bbbbbbbbbbbbbbbbbbbbbb",
        );
        expect(tryExtractShareId("https://kio.ac/c/cccccccccccccccccccccc?auto=1")).toBe(
            "cccccccccccccccccccccc",
        );
    });

    it("returns null for the wrong host", () => {
        expect(tryExtractShareId("https://transfer.it/c/aaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
        expect(tryExtractShareId("https://evil.com/c/aaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    });

    it("returns null for the wrong path prefix or length", () => {
        expect(tryExtractShareId("https://kio.ac/t/aaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
        expect(tryExtractShareId("https://kio.ac/c/short")).toBeNull();
    });

    it("returns null for malformed URLs", () => {
        expect(tryExtractShareId("not a url")).toBeNull();
        expect(tryExtractShareId("")).toBeNull();
    });
});

describe("tryExtractTransferId", () => {
    it("extracts the transfer id from a transfer.it URL", () => {
        expect(tryExtractTransferId("https://transfer.it/t/abcd1234ef56")).toBe("abcd1234ef56");
    });

    it("accepts the www subdomain", () => {
        expect(tryExtractTransferId("https://www.transfer.it/t/abcd1234ef56")).toBe("abcd1234ef56");
    });

    it("returns null for the wrong host or path prefix", () => {
        expect(tryExtractTransferId("https://kio.ac/t/abcd1234ef56")).toBeNull();
        expect(tryExtractTransferId("https://transfer.it/c/abcd1234ef56")).toBeNull();
    });

    it("returns null for the wrong length", () => {
        expect(tryExtractTransferId("https://transfer.it/t/short")).toBeNull();
    });

    it("returns null for ids with characters outside the allowed alphabet", () => {
        // '+' is not in TRANSFER_ID_PATTERN (base64url subset).
        expect(tryExtractTransferId("https://transfer.it/t/abcd+234ef!6")).toBeNull();
    });
});

describe("tryParseShareUrl / tryParseTransferUrl", () => {
    it("parses a valid kio.ac URL after codec-validating the id", () => {
        const shareId = uuidBytesToShareId(SAMPLE_BYTES);
        expect(tryParseShareUrl(`https://kio.ac/c/${shareId}`)).toBe(shareId);
    });

    it("returns null when the id fails codec validation", () => {
        // Length is valid (22) but '%' is not in the alphabet.
        expect(tryParseShareUrl("https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaa%")).toBeNull();
    });

    it("parses a transfer.it URL", () => {
        expect(tryParseTransferUrl("https://transfer.it/t/abcd1234ef56")).toBe("abcd1234ef56");
        expect(tryParseTransferUrl("https://transfer.it/t/short")).toBeNull();
    });
});

describe("tryParseDownloadUrl", () => {
    it("classifies kio.ac URLs as the kiosk provider", () => {
        const shareId = uuidBytesToShareId(SAMPLE_BYTES);
        expect(tryParseDownloadUrl(`https://kio.ac/c/${shareId}`)).toEqual({
            provider: "kiosk",
            id: shareId,
        });
    });

    it("classifies transfer.it URLs as the transfer provider", () => {
        expect(tryParseDownloadUrl("https://transfer.it/t/abcd1234ef56")).toEqual({
            provider: "transfer",
            id: "abcd1234ef56",
        });
    });

    it("returns null for unknown URLs", () => {
        expect(tryParseDownloadUrl("https://example.com/something")).toBeNull();
        expect(tryParseDownloadUrl("garbage")).toBeNull();
    });
});

describe("buildShareUrl / buildTransferUrl", () => {
    it("builds canonical URLs against the known hosts", () => {
        expect(buildShareUrl("aaaaaaaaaaaaaaaaaaaaaa")).toBe(
            `https://${SHARE_HOST}/c/aaaaaaaaaaaaaaaaaaaaaa`,
        );
        expect(buildTransferUrl("abcd1234ef56")).toBe(`https://${TRANSFER_HOST}/t/abcd1234ef56`);
    });
});

describe("tryDecodeShareUrlBase64", () => {
    it("decodes a single base64 layer wrapping a download URL", () => {
        const url = "https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa";
        const encoded = Buffer.from(url).toString("base64");
        expect(tryDecodeShareUrlBase64(encoded)).toBe(url);
    });

    it("decodes nested base64 layers until a download URL appears", () => {
        const url = "https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa";
        const once = Buffer.from(url).toString("base64");
        const twice = Buffer.from(once).toString("base64");
        expect(tryDecodeShareUrlBase64(twice)).toBe(url);
    });

    it("returns null when no layer resolves to a download URL within 5 iterations", () => {
        // A base64 string that decodes to another non-URL base64 string, never
        // producing a kio.ac/transfer.it URL.
        let current = Buffer.from("plain text with no url inside").toString("base64");
        for (let i = 0; i < 6; i += 1) {
            current = Buffer.from(current).toString("base64");
        }
        expect(tryDecodeShareUrlBase64(current)).toBeNull();
    });

    it("returns null for empty or non-base64 input", () => {
        expect(tryDecodeShareUrlBase64("")).toBeNull();
        expect(tryDecodeShareUrlBase64("   ")).toBeNull();
        expect(tryDecodeShareUrlBase64("not!base64?")).toBeNull();
    });
});
