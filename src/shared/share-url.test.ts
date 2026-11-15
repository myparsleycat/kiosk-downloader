import { describe, expect, it } from "vitest";

import {
    SHARE_HOST,
    TRANSFER_HOST,
    WORKUPLOAD_HOST,
    buildShareUrl,
    buildTransferUrl,
    buildWorkuploadUrl,
    shareIdToUuidBytes,
    tryDecodeShareUrlBase64,
    parseBulkShareInputs,
    tryExtractShareId,
    tryExtractTransferId,
    isAutoCommitShareInput,
    tryParseDirectUrl,
    tryParseDownloadUrl,
    tryParseMegaUrl,
    tryParseShareUrl,
    tryParseTransferUrl,
    tryParseWorkuploadUrl,
    uuidBytesToShareId,
    EXTENDED_SHARE_PREFIX,
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

    it("normalizes Workupload file and start URLs to the same file identity", () => {
        expect(tryParseDownloadUrl("https://workupload.com/file/aaaaaaaaaaa")).toEqual({
            provider: "workupload",
            id: "aaaaaaaaaaa",
            kind: "file",
        });
        expect(tryParseDownloadUrl("https://www.workupload.com/start/aaaaaaaaaaa")).toEqual({
            provider: "workupload",
            id: "aaaaaaaaaaa",
            kind: "file",
        });
    });

    it("classifies Workupload archive URLs separately", () => {
        expect(tryParseDownloadUrl("https://workupload.com/archive/bbbbbbbbbb/")).toEqual({
            provider: "workupload",
            id: "bbbbbbbbbb",
            kind: "archive",
        });
    });

    it("treats other http(s) URLs as direct downloads", () => {
        expect(tryParseDownloadUrl("https://example.com/something")).toEqual({
            provider: "direct",
            id: "https://example.com/something",
        });
        expect(tryParseDownloadUrl("garbage")).toBeNull();
    });
});

describe("tryParseWorkuploadUrl", () => {
    it("rejects unsafe or ambiguous URL variations", () => {
        expect(tryParseWorkuploadUrl("https://workupload.com/file/aaaaaaaaaaa?x=1")).toBeNull();
        expect(
            tryParseWorkuploadUrl("https://workupload.com/file/aaaaaaaaaaa#download"),
        ).toBeNull();
        expect(tryParseWorkuploadUrl("https://user@workupload.com/file/aaaaaaaaaaa")).toBeNull();
        expect(tryParseWorkuploadUrl("https://workupload.com:444/file/aaaaaaaaaaa")).toBeNull();
        expect(tryParseWorkuploadUrl("http://workupload.com/file/aaaaaaaaaaa")).toBeNull();
        expect(tryParseWorkuploadUrl("https://evil.workupload.com/file/aaaaaaaaaaa")).toBeNull();
        expect(tryParseWorkuploadUrl("https://workupload.com/file/aaaaaaaaaaa/extra")).toBeNull();
        expect(tryParseWorkuploadUrl("https://workupload.com/file/aaaaaaaa-MjB")).toBeNull();
    });
});

describe("buildShareUrl / buildTransferUrl / buildWorkuploadUrl", () => {
    it("builds canonical URLs against the known hosts", () => {
        expect(buildShareUrl("aaaaaaaaaaaaaaaaaaaaaa")).toBe(
            `https://${SHARE_HOST}/c/aaaaaaaaaaaaaaaaaaaaaa`,
        );
        expect(buildTransferUrl("abcd1234ef56")).toBe(`https://${TRANSFER_HOST}/t/abcd1234ef56`);
        expect(buildWorkuploadUrl("aaaaaaaaaaa")).toBe(
            `https://${WORKUPLOAD_HOST}/file/aaaaaaaaaaa`,
        );
        expect(buildWorkuploadUrl("bbbbbbbbbb", "archive")).toBe(
            `https://${WORKUPLOAD_HOST}/archive/bbbbbbbbbb`,
        );
    });

    it("rejects invalid Workupload ids", () => {
        expect(() => buildWorkuploadUrl("bad-id")).toThrow("Invalid Workupload id");
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

    it("decodes a Workupload archive URL", () => {
        const url = "https://workupload.com/archive/bbbbbbbbbb";
        expect(tryDecodeShareUrlBase64(Buffer.from(url).toString("base64"))).toBe(url);
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

    it("decodes base64 with missing padding", () => {
        const url = "https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa";
        const encoded = Buffer.from(url).toString("base64").replace(/=+$/, "");
        expect(tryDecodeShareUrlBase64(encoded)).toBe(url);
    });

    it("decodes base64url-encoded input (unpadded)", () => {
        const url = "https://transfer.it/t/abcd1234ef56";
        const encoded = Buffer.from(url).toString("base64url");
        expect(encoded).not.toContain("=");
        expect(tryDecodeShareUrlBase64(encoded)).toBe(url);
    });

    it("decodes a Workupload URL with missing padding", () => {
        const url = "https://workupload.com/file/aaaaaaaaaaa";
        const encoded = Buffer.from(url).toString("base64").replace(/=+$/, "");
        expect(tryDecodeShareUrlBase64(encoded)).toBe(url);
    });

    it("decodes a Workupload URL in base64url form", () => {
        const url = "https://workupload.com/archive/bbbbbbbbbb";
        const encoded = Buffer.from(url).toString("base64url");
        expect(encoded).not.toContain("=");
        expect(tryDecodeShareUrlBase64(encoded)).toBe(url);
    });

    it("returns null for empty or non-base64 input", () => {
        expect(tryDecodeShareUrlBase64("")).toBeNull();
        expect(tryDecodeShareUrlBase64("   ")).toBeNull();
        expect(tryDecodeShareUrlBase64("not!base64?")).toBeNull();
    });
});

describe("parseBulkShareInputs", () => {
    const kiosk = "https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa";
    const transfer = "https://transfer.it/t/abcd1234ef56";
    it("splits on newlines, commas, and trims empty tokens", () => {
        expect(parseBulkShareInputs(` ${kiosk} ,\n${transfer}\r\n\n`)).toEqual({
            urls: [kiosk, transfer],
            invalid: [],
        });
    });
    it("decodes base64 tokens and keeps raw extended share inputs", () => {
        const encoded = Buffer.from(kiosk).toString("base64");
        const extended = `${EXTENDED_SHARE_PREFIX}payload`;
        expect(parseBulkShareInputs(`${encoded}\n${extended}`)).toEqual({
            urls: [kiosk, extended],
            invalid: [],
        });
    });
    it("deduplicates resolved URLs and reports invalid tokens", () => {
        const encoded = Buffer.from(kiosk).toString("base64");
        expect(parseBulkShareInputs(`${kiosk}, not-a-link, ${encoded}, garbage`)).toEqual({
            urls: [kiosk],
            invalid: ["not-a-link", "garbage"],
        });
    });
    it.each([
        "mega://enc?QUJD,REVG==",
        "mega://fenc?QUJD,REVG==",
        "mega://enc2/?QUJD,,REVG==",
        "mega://fenc2/?QUJD,,REVG==",
    ])("keeps encoded Mega payload commas and adjacent links intact: %s", (mega) => {
        expect(parseBulkShareInputs(mega)).toEqual({ urls: [mega], invalid: [] });

        const direct = "https://example.com/get?ids=1,,2";
        expect(parseBulkShareInputs(`${direct},${mega},${kiosk}, ${transfer}`)).toEqual({
            urls: [direct, mega, kiosk, transfer],
            invalid: [],
        });
    });
});

describe("tryParseDirectUrl", () => {
    it("accepts http and https URLs and strips the fragment", () => {
        expect(tryParseDirectUrl("http://example.com/a.zip")).toBe("http://example.com/a.zip");
        expect(tryParseDirectUrl(" https://cdn.example.com/f.bin?sig=a,b#part ")).toBe(
            "https://cdn.example.com/f.bin?sig=a,b",
        );
    });

    it("rejects other schemes, credentials and share-provider hosts", () => {
        expect(tryParseDirectUrl("ftp://example.com/a.zip")).toBeNull();
        expect(tryParseDirectUrl("https://user:pw@example.com/a.zip")).toBeNull();
        expect(tryParseDirectUrl("https://kio.ac/c/short")).toBeNull();
        expect(tryParseDirectUrl("https://www.transfer.it/t/short")).toBeNull();
        expect(tryParseDirectUrl("https://workupload.com/file/a?b=1")).toBeNull();
    });

    it("lets recognized share links win over the direct fallback", () => {
        expect(tryParseDownloadUrl("https://transfer.it/t/abcd1234ef56")?.provider).toBe(
            "transfer",
        );
    });

    it("decodes a base64-encoded direct URL", () => {
        const url = "https://example.com/file.zip";
        expect(tryDecodeShareUrlBase64(Buffer.from(url).toString("base64"))).toBe(url);
    });
});

describe("isAutoCommitShareInput", () => {
    it("auto-commits share links but not direct URLs", () => {
        expect(isAutoCommitShareInput("https://transfer.it/t/abcd1234ef56")).toBe(true);
        expect(isAutoCommitShareInput(`${EXTENDED_SHARE_PREFIX}payload`)).toBe(true);
        expect(isAutoCommitShareInput("https://example.com/file.zip")).toBe(false);
        expect(isAutoCommitShareInput("https://exa")).toBe(false);
    });
});

describe("parseBulkShareInputs with direct URLs", () => {
    it("keeps commas inside a direct URL and still splits separate links", () => {
        const direct = "https://example.com/get?ids=1,2,3";
        const other = "https://example.com/other.zip";
        expect(parseBulkShareInputs(`${direct}\n${direct}, ${other}`)).toEqual({
            urls: [direct, other],
            invalid: [],
        });
    });
});

describe("direct URL edge cases", () => {
    it("rejects text that holds more than one link or any whitespace", () => {
        expect(tryParseDirectUrl("https://a.example/x.zip\nhttps://b.example/y.zip")).toBeNull();
        expect(tryParseDirectUrl("https://a.example/x.zip https://b.example/y.zip")).toBeNull();
        expect(tryParseDirectUrl("https://a.example/x.zip\thttps://b.example/y.zip")).toBeNull();
        expect(tryParseDirectUrl("  https://a.example/x.zip  ")).toBe("https://a.example/x.zip");
    });

    it("rejects share-provider subdomains and trailing-dot hosts", () => {
        expect(tryParseDirectUrl("https://kio.ac./c/AAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
        expect(tryParseDirectUrl("https://m.kio.ac/c/short")).toBeNull();
        expect(tryParseDirectUrl("https://en.workupload.com/file/abc")).toBeNull();
        expect(tryParseDirectUrl("https://transfer.it./t/abcdefghijkl")).toBeNull();
        expect(tryParseDirectUrl("https://notkio.ac/file.zip")).toBe("https://notkio.ac/file.zip");
    });

    it("keeps comma queries together but reports malformed links after a comma", () => {
        expect(parseBulkShareInputs("https://example.com/a?ids=1,,2")).toEqual({
            urls: ["https://example.com/a?ids=1,,2"],
            invalid: [],
        });
        expect(parseBulkShareInputs("https://example.com/1.zip,https://kio.ac/c/short")).toEqual({
            urls: ["https://example.com/1.zip"],
            invalid: ["https://kio.ac/c/short"],
        });
        expect(parseBulkShareInputs("https://example.com/1.zip,htps://x/2.zip")).toEqual({
            urls: ["https://example.com/1.zip"],
            invalid: ["htps://x/2.zip"],
        });
        expect(parseBulkShareInputs("https://example.com/a.zip,")).toEqual({
            urls: ["https://example.com/a.zip"],
            invalid: [],
        });
    });
});

describe("tryParseMegaUrl", () => {
    const fileKey = "A".repeat(43);
    const folderKey = "B".repeat(22);

    it.each([
        [
            `https://mega.nz/file/abcd1234#${fileKey}`,
            { kind: "file", handle: "abcd1234", key: fileKey },
        ],
        [`mega.co.nz/file/abcd1234#${fileKey}`, { kind: "file", handle: "abcd1234", key: fileKey }],
        [
            `https://mega.nz/#!abcd1234!${fileKey}`,
            { kind: "file", handle: "abcd1234", key: fileKey },
        ],
        [`mega://#!abcd1234!${fileKey}`, { kind: "file", handle: "abcd1234", key: fileKey }],
        [
            `https://www.mega.nz/folder/root1234#${folderKey}`,
            { kind: "folder", handle: "root1234", key: folderKey },
        ],
        [
            `https://mega.nz/#F!root1234!${folderKey}`,
            { kind: "folder", handle: "root1234", key: folderKey },
        ],
        [`mega:F!root1234!${folderKey}`, { kind: "folder", handle: "root1234", key: folderKey }],
        [
            `https://mega.nz/folder/root1234#${folderKey}/folder/sub12345`,
            { kind: "folder", handle: "root1234", key: folderKey, subFolderId: "sub12345" },
        ],
        [
            `https://mega.nz/folder/root1234#${folderKey}/file/file1234`,
            { kind: "folder", handle: "root1234", key: folderKey, subFileId: "file1234" },
        ],
        ["https://mega.nz/file/abcd1234", { kind: "file", handle: "abcd1234" }],
    ])("parses %s", (url, expected) => {
        expect(tryParseMegaUrl(url)).toEqual({ type: "public", ...expected });
    });

    it("parses MegaDownloader encoded links", () => {
        expect(tryParseMegaUrl("mega://enc?QUJD-_")).toEqual({
            type: "encoded",
            kind: "file",
            version: 1,
            payload: "QUJD-_",
        });
        expect(tryParseMegaUrl("mega://fenc2/?QUJD")).toMatchObject({ kind: "folder", version: 2 });
    });

    it("rejects partial keys and keys on the wrong link kind", () => {
        expect(tryParseMegaUrl(`https://mega.nz/file/abcd1234#${fileKey.slice(1)}`)).toBeNull();
        expect(tryParseMegaUrl(`https://mega.nz/folder/root1234#${fileKey}`)).toBeNull();
        expect(tryParseMegaUrl(`https://mega.nz/file/abcd1234#${fileKey}/file/x`)).toBeNull();
    });

    it("keeps malformed Mega links out of direct downloads", () => {
        expect(tryParseDirectUrl("https://mega.nz/file/abcd1234#short")).toBeNull();
        expect(tryParseDownloadUrl("https://mega.nz/file/abcd1234#short")).toBeNull();
        expect(tryParseDownloadUrl(`https://mega.nz/file/abcd1234#${fileKey}`)?.provider).toBe(
            "mega",
        );
    });

    it("auto-loads only links that carry their key", () => {
        expect(isAutoCommitShareInput(`https://mega.nz/file/abcd1234#${fileKey}`)).toBe(true);
        expect(isAutoCommitShareInput("https://mega.nz/file/abcd1234")).toBe(false);
        expect(isAutoCommitShareInput("mega://enc?QUJD")).toBe(true);
    });
});
