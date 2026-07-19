import { createHash, timingSafeEqual } from "node:crypto";

import type {
    CollectionTree,
    DownloadProvider,
    DownloadTransferFile,
    DownloadTransferPayload,
} from "@shared/types";
import { DOWNLOAD_TRANSFER_KIND, DOWNLOAD_TRANSFER_VERSION } from "@shared/types";
import { decode, encode } from "cbor-x";

import { compressZstdSync, decompressZstdSync } from "../../lib/zstd";

export const MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const MAX_DOWNLOAD_TRANSFER_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export const KDX_MAGIC = Buffer.from("KDX1");
export const KDX_CHECKSUM_BYTES = 32;
export const KDX_HEADER_SIZE = KDX_MAGIC.length + KDX_CHECKSUM_BYTES;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function encodeDownloadTransfer(payload: DownloadTransferPayload): Buffer {
    const body = compressZstdSync(Buffer.from(encode(payload)));
    const checksum = createHash("sha256").update(body).digest();
    return Buffer.concat([KDX_MAGIC, checksum, body]);
}

export function decodeDownloadTransfer(raw: Buffer): DownloadTransferPayload {
    if (raw.length > MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES) {
        throw new Error("Transfer file is too large.");
    }

    const body = unwrapTransferBody(raw);
    let inflated: Buffer;
    try {
        inflated = decompressZstdSync(body, {
            maxOutputLength: MAX_DOWNLOAD_TRANSFER_DECOMPRESSED_BYTES,
        });
    } catch {
        throw new Error("Invalid transfer file.");
    }

    let decoded: unknown;
    try {
        decoded = decode(inflated);
    } catch {
        throw new Error("Invalid transfer file.");
    }
    return requireDownloadTransferPayload(decoded);
}

function unwrapTransferBody(raw: Buffer): Buffer {
    if (raw.length >= KDX_HEADER_SIZE && raw.subarray(0, KDX_MAGIC.length).equals(KDX_MAGIC)) {
        const expected = raw.subarray(KDX_MAGIC.length, KDX_HEADER_SIZE);
        const body = raw.subarray(KDX_HEADER_SIZE);
        const actual = createHash("sha256").update(body).digest();
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            throw new Error("Transfer file is corrupted.");
        }
        return body;
    }

    if (raw.length >= ZSTD_MAGIC.length && raw.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
        return raw;
    }

    throw new Error("Invalid transfer file.");
}

export function requireDownloadTransferPayload(input: unknown): DownloadTransferPayload {
    if (!isRecord(input)) {
        throw new Error("Invalid transfer file.");
    }
    if (input.version !== DOWNLOAD_TRANSFER_VERSION) {
        throw new Error(`Unsupported transfer file version: ${String(input.version)}.`);
    }
    if (input.kind !== DOWNLOAD_TRANSFER_KIND) {
        throw new Error("Invalid transfer file kind.");
    }
    if (typeof input.exportedAt !== "number" || !Number.isFinite(input.exportedAt)) {
        throw new Error("Invalid transfer file.");
    }
    const collection = requireTransferCollection(input.collection);
    if (!Array.isArray(input.files) || input.files.length === 0) {
        throw new Error("Transfer file has no files.");
    }
    const files = input.files.map((file, index) => requireTransferFile(file, index));
    if (!files.some((file) => file.selected)) {
        throw new Error("No files selected.");
    }
    return {
        version: DOWNLOAD_TRANSFER_VERSION,
        kind: DOWNLOAD_TRANSFER_KIND,
        exportedAt: input.exportedAt,
        collection,
        files,
    };
}

function requireTransferCollection(input: unknown): DownloadTransferPayload["collection"] {
    if (!isRecord(input)) {
        throw new Error("Invalid transfer collection.");
    }
    if (typeof input.shareId !== "string" || input.shareId.length === 0) {
        throw new Error("Invalid transfer collection.");
    }
    if (typeof input.sourceUrl !== "string" || input.sourceUrl.length === 0) {
        throw new Error("Invalid transfer collection.");
    }
    if (typeof input.name !== "string") {
        throw new Error("Invalid transfer collection.");
    }
    if (typeof input.rootId !== "string" || input.rootId.length === 0) {
        throw new Error("Invalid transfer collection.");
    }
    if (!isPositiveSafeInteger(input.segmentSize)) {
        throw new Error("Invalid transfer collection.");
    }
    if (typeof input.expires !== "number" || !Number.isFinite(input.expires)) {
        throw new Error("Invalid transfer collection.");
    }
    if (typeof input.asciiFilenames !== "boolean") {
        throw new Error("Invalid transfer collection.");
    }
    if (input.provider !== "kiosk" && input.provider !== "transfer") {
        throw new Error("Invalid transfer collection.");
    }
    const tree = requireCollectionTree(input.tree);
    const passwordPlain = typeof input.passwordPlain === "string" ? input.passwordPlain : null;
    return {
        shareId: input.shareId,
        sourceUrl: input.sourceUrl,
        passwordPlain,
        name: input.name,
        rootId: input.rootId,
        segmentSize: input.segmentSize,
        expires: input.expires,
        tree,
        asciiFilenames: input.asciiFilenames,
        provider: input.provider as DownloadProvider,
    };
}

function requireTransferFile(input: unknown, index: number): DownloadTransferFile {
    if (!isRecord(input)) {
        throw new Error(`Invalid transfer file entry at ${index}.`);
    }
    if (typeof input.remoteId !== "string" || input.remoteId.length === 0) {
        throw new Error(`Invalid transfer file entry at ${index}.`);
    }
    if (typeof input.path !== "string" || input.path.length === 0) {
        throw new Error(`Invalid transfer file entry at ${index}.`);
    }
    if (typeof input.name !== "string") {
        throw new Error(`Invalid transfer file entry at ${index}.`);
    }
    if (!isNonNegativeSafeInteger(input.size)) {
        throw new Error(`Invalid transfer file entry at ${index}.`);
    }
    if (typeof input.selected !== "boolean") {
        throw new Error(`Invalid transfer file entry at ${index}.`);
    }
    if (input.status !== "completed" && input.status !== "pending") {
        throw new Error(`Invalid transfer file entry at ${index}.`);
    }
    if (typeof input.completedElsewhere !== "boolean") {
        throw new Error(`Invalid transfer file entry at ${index}.`);
    }
    if (input.sourceKind !== "file" && input.sourceKind !== "zip_entry") {
        throw new Error(`Invalid transfer file entry at ${index}.`);
    }
    const zipEntryJson = typeof input.zipEntryJson === "string" ? input.zipEntryJson : null;
    const sourceMetaJson = typeof input.sourceMetaJson === "string" ? input.sourceMetaJson : null;
    return {
        remoteId: input.remoteId,
        path: input.path,
        name: input.name,
        size: input.size,
        selected: input.selected,
        status: input.status,
        completedElsewhere: input.completedElsewhere,
        sourceKind: input.sourceKind,
        zipEntryJson,
        sourceMetaJson,
    };
}

function requireCollectionTree(input: unknown): CollectionTree {
    if (!isRecord(input) || input.type !== "dir") {
        throwInvalidCollectionTree();
    }

    const seen = new WeakSet<object>();
    const pending: Array<{ node: Record<string, unknown>; kind: "dir" | "file" | "zip" }> = [
        { node: input, kind: "dir" },
    ];

    while (pending.length > 0) {
        const current = pending.pop()!;
        if (seen.has(current.node)) {
            throwInvalidCollectionTree();
        }
        seen.add(current.node);

        if (
            current.node.type !== current.kind ||
            typeof current.node.id !== "string" ||
            current.node.id.length === 0 ||
            typeof current.node.name !== "string"
        ) {
            throwInvalidCollectionTree();
        }

        if (current.kind === "file") {
            requireFileNode(current.node);
            continue;
        }

        if (current.kind === "zip" && !isNonNegativeSafeInteger(current.node.size)) {
            throwInvalidCollectionTree();
        }
        if (current.kind === "zip" && current.node.entries === null) {
            continue;
        }
        if (!Array.isArray(current.node.entries)) {
            throwInvalidCollectionTree();
        }

        for (const entry of current.node.entries) {
            if (
                !isRecord(entry) ||
                (entry.kind !== "dir" && entry.kind !== "file" && entry.kind !== "zip") ||
                !isRecord(entry.node) ||
                entry.node.type !== entry.kind
            ) {
                throwInvalidCollectionTree();
            }
            pending.push({ node: entry.node, kind: entry.kind });
        }
    }

    return input as unknown as CollectionTree;
}

function requireFileNode(node: Record<string, unknown>) {
    if (!isNonNegativeSafeInteger(node.size)) {
        throwInvalidCollectionTree();
    }
    if (node.zipEntry === undefined) {
        return;
    }
    if (
        !isRecord(node.zipEntry) ||
        typeof node.zipEntry.path !== "string" ||
        node.zipEntry.path.length === 0 ||
        !isNonNegativeSafeInteger(node.zipEntry.offset) ||
        !isNonNegativeSafeInteger(node.zipEntry.compressedSize) ||
        !isNonNegativeSafeInteger(node.zipEntry.uncompressedSize) ||
        !isNonNegativeSafeInteger(node.zipEntry.compressionMethod) ||
        typeof node.zipEntry.encrypted !== "boolean"
    ) {
        throwInvalidCollectionTree();
    }
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function throwInvalidCollectionTree(): never {
    throw new Error("Invalid transfer collection tree.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
