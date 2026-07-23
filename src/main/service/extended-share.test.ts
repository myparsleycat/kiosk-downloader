import { createHash } from "node:crypto";

import { encode as encodeCbor } from "cbor-x";
import { describe, expect, it } from "vitest";

import { compressZstdSync } from "../lib/zstd";
import {
    EXTENDED_SHARE_PREFIX,
    KDS_CHECKSUM_BYTES,
    KDS_HEADER_SIZE,
    KDS_MAGIC,
    MAX_EXTENDED_SHARE_DECOMPRESSED_BYTES,
    MAX_EXTENDED_SHARE_ENCODED_BYTES,
    decodeExtendedShare,
    decodeExtendedShareFile,
    encodeExtendedShare,
    encodeExtendedShareFile,
    isExtendedShareFile,
    type ExtendedSharePayload,
} from "./extended-share";

function createPayload(): ExtendedSharePayload {
    return {
        collectionIds: [
            Buffer.from("00112233445566778899aabbccddeeff", "hex"),
            Buffer.from("ffeeddccbbaa99887766554433221100", "hex"),
        ],
        splitFiles: [
            {
                path: "folder/large.bin",
                size: 12,
                sha256: createHash("sha256").update("large file").digest(),
                pieces: [
                    {
                        sourceIndex: 0,
                        remoteFileId: Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "hex"),
                        offset: 0,
                        length: 5,
                    },
                    {
                        sourceIndex: 1,
                        remoteFileId: Buffer.from("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "hex"),
                        offset: 5,
                        length: 7,
                    },
                ],
            },
        ],
    };
}

function decodeEnvelope(value: string) {
    return Buffer.from(value.slice(EXTENDED_SHARE_PREFIX.length), "base64url");
}

function encodeEnvelope(value: Buffer) {
    return `${EXTENDED_SHARE_PREFIX}${value.toString("base64url")}`;
}

function plaintextBodyEnvelope(body: Buffer, header = Buffer.from([1, 0, 0, 0])) {
    const checksum = createHash("sha256").update(header).update(body).digest().subarray(0, 16);
    return encodeEnvelope(Buffer.concat([header, body, checksum]));
}

function plaintextEnvelope(payload: unknown, header = Buffer.from([1, 0, 0, 0])) {
    return plaintextBodyEnvelope(Buffer.from(encodeCbor(payload)), header);
}

describe("extended share codec", () => {
    it("round trips compact plaintext payloads with a KDE1 prefix", async () => {
        const payload = createPayload();
        const encoded = await encodeExtendedShare(payload);

        expect(encoded.startsWith(EXTENDED_SHARE_PREFIX)).toBe(true);
        expect(encoded).not.toContain("=");
        expect(await decodeExtendedShare(encoded)).toEqual(payload);
    });

    it("round trips KDE1 share values through the .kds binary container", async () => {
        const payload = createPayload();
        const encoded = await encodeExtendedShare(payload);
        const file = encodeExtendedShareFile(encoded);

        expect(isExtendedShareFile(file)).toBe(true);
        expect(file.subarray(0, KDS_MAGIC.length)).toEqual(KDS_MAGIC);
        expect(file.length).toBeGreaterThan(KDS_HEADER_SIZE);
        expect(KDS_CHECKSUM_BYTES).toBe(32);
        expect(decodeExtendedShareFile(file)).toBe(encoded);
        expect(await decodeExtendedShare(decodeExtendedShareFile(file))).toEqual(payload);
    });

    it("rejects corrupted .kds files", async () => {
        const encoded = await encodeExtendedShare(createPayload());
        const file = encodeExtendedShareFile(encoded);
        file[KDS_HEADER_SIZE] ^= 0xff;
        expect(() => decodeExtendedShareFile(file)).toThrow("Extended share file is corrupted.");
    });

    it("supports a zero-byte one-piece mapping for an internally renamed file", async () => {
        const payload = createPayload();
        payload.splitFiles = [
            {
                path: "question?.txt",
                size: 0,
                sha256: createHash("sha256").update("").digest(),
                pieces: [
                    {
                        sourceIndex: 0,
                        remoteFileId: Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "hex"),
                        offset: 0,
                        length: 0,
                    },
                ],
            },
        ];

        await expect(decodeExtendedShare(await encodeExtendedShare(payload))).resolves.toEqual(
            payload,
        );
    });

    it("round trips packed file ranges without requiring per-file hashes", async () => {
        const payload = createPayload();
        payload.splitFiles = [
            {
                path: "second.txt",
                size: 6,
                pieces: [
                    {
                        sourceIndex: 0,
                        remoteFileId: Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "hex"),
                        offset: 0,
                        length: 6,
                        remoteOffset: 5,
                    },
                ],
            },
        ];

        await expect(decodeExtendedShare(await encodeExtendedShare(payload))).resolves.toEqual(
            payload,
        );
    });

    it("round trips password-protected payloads and marks AES-256-GCM in the header", async () => {
        const payload = createPayload();
        const encoded = await encodeExtendedShare(payload, "correct horse battery staple");

        expect(decodeEnvelope(encoded)[0]).toBe(1);
        expect(decodeEnvelope(encoded).subarray(2, 4)).toEqual(Buffer.from([1, 0]));
        await expect(decodeExtendedShare(encoded)).rejects.toThrow("Password is required");
        await expect(decodeExtendedShare(encoded, "wrong password")).rejects.toThrow(
            "Incorrect password or corrupted",
        );
        await expect(decodeExtendedShare(encoded, "correct horse battery staple")).resolves.toEqual(
            payload,
        );
    });

    it("uses zstd only when it makes the CBOR payload shorter", async () => {
        const compressible = createPayload();
        compressible.splitFiles[0]!.path = "nested/".repeat(300) + "large.bin";
        const compressed = await encodeExtendedShare(compressible);
        const minimal = await encodeExtendedShare({
            collectionIds: [Buffer.alloc(16)],
            splitFiles: [],
        });

        expect(decodeEnvelope(compressed)[1]).toBe(1);
        expect(decodeEnvelope(minimal)[1]).toBe(0);
        await expect(decodeExtendedShare(compressed)).resolves.toEqual(compressible);
    });

    it("rejects tampering for plaintext and encrypted envelopes", async () => {
        const plaintext = decodeEnvelope(await encodeExtendedShare(createPayload()));
        plaintext[plaintext.length - 17] ^= 0x01;
        await expect(decodeExtendedShare(encodeEnvelope(plaintext))).rejects.toThrow("Corrupted");

        const encrypted = decodeEnvelope(await encodeExtendedShare(createPayload(), "password"));
        encrypted[encrypted.length - 17] ^= 0x01;
        await expect(decodeExtendedShare(encodeEnvelope(encrypted), "password")).rejects.toThrow(
            "Incorrect password or corrupted",
        );
    });

    it.each([
        [Buffer.from([2, 0, 0, 0]), "Unsupported extended share version"],
        [Buffer.from([1, 2, 0, 0]), "Unsupported extended share compression"],
        [Buffer.from([1, 0, 2, 0]), "Unsupported extended share protection"],
        [Buffer.from([1, 0, 0, 1]), "Unsupported extended share header"],
    ])("rejects unsupported header %s", async (header, message) => {
        await expect(decodeExtendedShare(plaintextEnvelope([[], []], header))).rejects.toThrow(
            message,
        );
    });

    it.each([
        "not-a-share",
        `${EXTENDED_SHARE_PREFIX}YWJj=`,
        `${EXTENDED_SHARE_PREFIX}***`,
        EXTENDED_SHARE_PREFIX,
    ])("rejects invalid string framing", async (value) => {
        await expect(decodeExtendedShare(value)).rejects.toThrow(
            "Invalid extended share information",
        );
    });

    it("rejects invalid UUID, digest, source, and non-contiguous piece mappings", async () => {
        const payload = createPayload();
        payload.collectionIds[0] = Buffer.alloc(15);
        await expect(encodeExtendedShare(payload)).rejects.toThrow(
            "Invalid extended share payload",
        );

        const invalidDigest = createPayload();
        invalidDigest.splitFiles[0]!.sha256 = Buffer.alloc(31);
        await expect(encodeExtendedShare(invalidDigest)).rejects.toThrow(
            "Invalid extended share payload",
        );

        const invalidSource = createPayload();
        invalidSource.splitFiles[0]!.pieces[0]!.sourceIndex = 2;
        await expect(encodeExtendedShare(invalidSource)).rejects.toThrow(
            "Invalid extended share payload",
        );

        const gap = createPayload();
        gap.splitFiles[0]!.pieces[1]!.offset = 6;
        await expect(encodeExtendedShare(gap)).rejects.toThrow("Invalid extended share payload");
    });

    it("rejects malformed compact CBOR payloads", async () => {
        await expect(decodeExtendedShare(plaintextEnvelope({ collections: [] }))).rejects.toThrow(
            "Invalid extended share payload",
        );
        await expect(decodeExtendedShare(plaintextEnvelope([[], []]))).rejects.toThrow(
            "Invalid extended share payload",
        );
    });

    it("rejects encoded and decompressed data over the safety limits", async () => {
        await expect(
            decodeExtendedShare(
                `${EXTENDED_SHARE_PREFIX}${"A".repeat(
                    Math.ceil((MAX_EXTENDED_SHARE_ENCODED_BYTES * 4) / 3) + 1,
                )}`,
            ),
        ).rejects.toThrow("Invalid extended share information");

        const compressedBomb = compressZstdSync(
            Buffer.alloc(MAX_EXTENDED_SHARE_DECOMPRESSED_BYTES + 1),
        );
        await expect(
            decodeExtendedShare(plaintextBodyEnvelope(compressedBomb, Buffer.from([1, 1, 0, 0]))),
        ).rejects.toThrow("Invalid extended share information");
    });
});
