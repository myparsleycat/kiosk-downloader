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
const MAX_DOWNLOAD_TRANSFER_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export function encodeDownloadTransfer(payload: DownloadTransferPayload): Buffer {
    return compressZstdSync(Buffer.from(encode(payload)));
}

export function decodeDownloadTransfer(raw: Buffer): DownloadTransferPayload {
    if (raw.length > MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES) {
        throw new Error("Transfer file is too large.");
    }

    let inflated: Buffer;
    try {
        inflated = decompressZstdSync(raw, {
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
    if (typeof input.segmentSize !== "number" || !Number.isFinite(input.segmentSize)) {
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
    if (!isRecord(input.tree) || input.tree.type !== "dir") {
        throw new Error("Invalid transfer collection tree.");
    }
    const passwordPlain =
        input.passwordPlain == null
            ? null
            : typeof input.passwordPlain === "string"
              ? input.passwordPlain
              : null;
    return {
        shareId: input.shareId,
        sourceUrl: input.sourceUrl,
        passwordPlain,
        name: input.name,
        rootId: input.rootId,
        segmentSize: Math.floor(input.segmentSize),
        expires: input.expires,
        tree: input.tree as unknown as CollectionTree,
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
    if (typeof input.size !== "number" || !Number.isFinite(input.size) || input.size < 0) {
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
    const zipEntryJson =
        input.zipEntryJson == null
            ? null
            : typeof input.zipEntryJson === "string"
              ? input.zipEntryJson
              : null;
    const sourceMetaJson =
        input.sourceMetaJson == null
            ? null
            : typeof input.sourceMetaJson === "string"
              ? input.sourceMetaJson
              : null;
    return {
        remoteId: input.remoteId,
        path: input.path,
        name: input.name,
        size: Math.floor(input.size),
        selected: input.selected,
        status: input.status,
        completedElsewhere: input.completedElsewhere,
        sourceKind: input.sourceKind,
        zipEntryJson,
        sourceMetaJson,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
