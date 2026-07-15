import { createHash } from "node:crypto";

import type { DownloadTransferPayload } from "@shared/types";
import { DOWNLOAD_TRANSFER_KIND, DOWNLOAD_TRANSFER_VERSION } from "@shared/types";
import { encode as encodeCbor } from "cbor-x";
import { describe, expect, it } from "vitest";

import { compressZstdSync } from "../../lib/zstd";
import {
    KDX_CHECKSUM_BYTES,
    KDX_HEADER_SIZE,
    KDX_MAGIC,
    MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES,
    MAX_DOWNLOAD_TRANSFER_DECOMPRESSED_BYTES,
    decodeDownloadTransfer,
    encodeDownloadTransfer,
    requireDownloadTransferPayload,
} from "./transfer-format";

function createPayload(): DownloadTransferPayload {
    return {
        version: DOWNLOAD_TRANSFER_VERSION,
        kind: DOWNLOAD_TRANSFER_KIND,
        exportedAt: 1_700_000_000_000,
        collection: {
            shareId: "share",
            sourceUrl: "https://example.com/share",
            passwordPlain: " password ",
            name: "Example",
            rootId: "root",
            segmentSize: 1024,
            expires: 2_000_000_000,
            tree: {
                type: "dir",
                id: "root",
                name: "",
                entries: [
                    {
                        kind: "dir",
                        node: {
                            type: "dir",
                            id: "folder",
                            name: "folder",
                            entries: [
                                {
                                    kind: "file",
                                    node: {
                                        type: "file",
                                        id: "file",
                                        name: "file.bin",
                                        size: 12,
                                    },
                                },
                            ],
                        },
                    },
                    {
                        kind: "zip",
                        node: {
                            type: "zip",
                            id: "archive",
                            name: "archive.zip",
                            size: 10,
                            entries: [
                                {
                                    kind: "file",
                                    node: {
                                        type: "file",
                                        id: "archive:entry",
                                        name: "entry.txt",
                                        size: 4,
                                        zipEntry: {
                                            path: "entry.txt",
                                            offset: 2,
                                            compressedSize: 3,
                                            uncompressedSize: 4,
                                            compressionMethod: 8,
                                            encrypted: false,
                                        },
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
            asciiFilenames: false,
            provider: "kiosk",
        },
        files: [
            {
                remoteId: "file",
                path: "folder/file.bin",
                name: "file.bin",
                size: 12,
                selected: true,
                status: "pending",
                completedElsewhere: false,
                sourceKind: "file",
                zipEntryJson: null,
                sourceMetaJson: null,
            },
        ],
    };
}

function encodeLegacyDownloadTransfer(payload: DownloadTransferPayload): Buffer {
    return compressZstdSync(Buffer.from(encodeCbor(payload)));
}

describe("download transfer format", () => {
    it("round trips a valid payload", () => {
        const payload = createPayload();

        expect(decodeDownloadTransfer(encodeDownloadTransfer(payload))).toEqual(payload);
    });

    it("writes a KDX1 header with a matching SHA-256 checksum", () => {
        const encoded = encodeDownloadTransfer(createPayload());
        const body = encoded.subarray(KDX_HEADER_SIZE);

        expect(encoded.subarray(0, KDX_MAGIC.length)).toEqual(KDX_MAGIC);
        expect(encoded.subarray(KDX_MAGIC.length, KDX_HEADER_SIZE)).toEqual(
            createHash("sha256").update(body).digest(),
        );
        expect(encoded.length).toBe(KDX_HEADER_SIZE + body.length);
        expect(KDX_CHECKSUM_BYTES).toBe(32);
    });

    it("accepts legacy raw zstd transfer files", () => {
        const payload = createPayload();

        expect(decodeDownloadTransfer(encodeLegacyDownloadTransfer(payload))).toEqual(payload);
    });

    it("rejects a corrupted checksum", () => {
        const encoded = encodeDownloadTransfer(createPayload());
        const corrupted = Buffer.from(encoded);
        corrupted[KDX_HEADER_SIZE] ^= 0xff;

        expect(() => decodeDownloadTransfer(corrupted)).toThrow("Transfer file is corrupted.");
    });

    it("rejects a truncated header", () => {
        expect(() => decodeDownloadTransfer(Buffer.from("KDX1"))).toThrow("Invalid transfer file.");
    });

    it("rejects non-kdx binary payloads", () => {
        expect(() => decodeDownloadTransfer(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toThrow(
            "Invalid transfer file.",
        );
    });

    it("rejects compressed input larger than the configured limit", () => {
        expect(() =>
            decodeDownloadTransfer(Buffer.alloc(MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES + 1)),
        ).toThrow("Transfer file is too large.");
    });

    it("rejects decompressed input larger than the configured limit", () => {
        const body = compressZstdSync(Buffer.alloc(MAX_DOWNLOAD_TRANSFER_DECOMPRESSED_BYTES + 1));
        const checksum = createHash("sha256").update(body).digest();
        const framed = Buffer.concat([KDX_MAGIC, checksum, body]);

        expect(() => decodeDownloadTransfer(framed)).toThrow("Invalid transfer file.");
    });

    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        "rejects invalid segment size %s",
        (segmentSize) => {
            const payload = createPayload();
            payload.collection.segmentSize = segmentSize;

            expect(() => requireDownloadTransferPayload(payload)).toThrow(
                "Invalid transfer collection.",
            );
        },
    );

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        "rejects invalid transfer file size %s",
        (size) => {
            const payload = createPayload();
            payload.files[0]!.size = size;

            expect(() => requireDownloadTransferPayload(payload)).toThrow(
                "Invalid transfer file entry at 0.",
            );
        },
    );

    it.each([
        [
            "entry kind and node type differ",
            (payload: DownloadTransferPayload) => {
                payload.collection.tree.entries[0]!.kind = "file";
            },
        ],
        [
            "a directory is missing entries",
            (payload: DownloadTransferPayload) => {
                delete (
                    payload.collection.tree.entries[0]!.node as unknown as { entries?: unknown }
                ).entries;
            },
        ],
        [
            "a file size is fractional",
            (payload: DownloadTransferPayload) => {
                const dir = payload.collection.tree.entries[0]!.node;
                if (dir.type === "dir") {
                    const file = dir.entries[0]!.node;
                    if (file.type === "file") {
                        file.size = 1.5;
                    }
                }
            },
        ],
        [
            "a ZIP size is outside the safe integer range",
            (payload: DownloadTransferPayload) => {
                const zip = payload.collection.tree.entries[1]!.node;
                if (zip.type === "zip") {
                    zip.size = Number.MAX_SAFE_INTEGER + 1;
                }
            },
        ],
        [
            "ZIP entry metadata is incomplete",
            (payload: DownloadTransferPayload) => {
                const zip = payload.collection.tree.entries[1]!.node;
                if (zip.type === "zip" && zip.entries) {
                    const file = zip.entries[0]!.node;
                    if (file.type === "file" && file.zipEntry) {
                        delete (file.zipEntry as Partial<typeof file.zipEntry>).encrypted;
                    }
                }
            },
        ],
        [
            "ZIP entry metadata is null",
            (payload: DownloadTransferPayload) => {
                const zip = payload.collection.tree.entries[1]!.node;
                if (zip.type === "zip" && zip.entries) {
                    const file = zip.entries[0]!.node;
                    if (file.type === "file") {
                        (file as unknown as { zipEntry: null }).zipEntry = null;
                    }
                }
            },
        ],
        [
            "ZIP entry metadata has an invalid number",
            (payload: DownloadTransferPayload) => {
                const zip = payload.collection.tree.entries[1]!.node;
                if (zip.type === "zip" && zip.entries) {
                    const file = zip.entries[0]!.node;
                    if (file.type === "file" && file.zipEntry) {
                        file.zipEntry.offset = -1;
                    }
                }
            },
        ],
    ])("rejects a malformed tree when %s", (_name, mutate) => {
        const payload = createPayload();
        mutate(payload);

        expect(() => requireDownloadTransferPayload(payload)).toThrow(
            "Invalid transfer collection tree.",
        );
    });

    it("rejects cyclic collection trees", () => {
        const payload = createPayload();
        payload.collection.tree.entries.push({ kind: "dir", node: payload.collection.tree });

        expect(() => requireDownloadTransferPayload(payload)).toThrow(
            "Invalid transfer collection tree.",
        );
    });

    it("rejects collection trees that reuse a node", () => {
        const payload = createPayload();
        payload.collection.tree.entries.push({
            kind: "dir",
            node: payload.collection.tree.entries[0]!.node,
        });

        expect(() => requireDownloadTransferPayload(payload)).toThrow(
            "Invalid transfer collection tree.",
        );
    });

    it("validates deeply nested trees without recursive traversal", () => {
        const payload = createPayload();
        payload.collection.tree.entries = [];
        let dir = payload.collection.tree;
        for (let depth = 0; depth < 20_000; depth += 1) {
            const child = {
                type: "dir" as const,
                id: `dir-${depth}`,
                name: `dir-${depth}`,
                entries: [],
            };
            dir.entries.push({ kind: "dir", node: child });
            dir = child;
        }

        expect(requireDownloadTransferPayload(payload).collection.tree).toBe(
            payload.collection.tree,
        );
    });
});
