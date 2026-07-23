import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    scrypt,
    timingSafeEqual,
} from "node:crypto";

import {
    EXTENDED_SHARE_INVALID_PASSWORD_ERROR,
    EXTENDED_SHARE_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import { EXTENDED_SHARE_PREFIX } from "@shared/share-url";
import { decode, encode } from "cbor-x";

import { compressZstdSync, decompressZstdSync } from "../lib/zstd";

export { EXTENDED_SHARE_PREFIX };
export const EXTENDED_SHARE_VERSION = 1;
export const MAX_EXTENDED_SHARE_ENCODED_BYTES = 16 * 1024 * 1024;
export const MAX_EXTENDED_SHARE_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** On-disk container for integrated extended share payloads (mirrors .kdx framing). */
export const KDS_MAGIC = Buffer.from("KDS1");
export const KDS_CHECKSUM_BYTES = 32;
export const KDS_HEADER_SIZE = KDS_MAGIC.length + KDS_CHECKSUM_BYTES;

const HEADER_BYTES = 4;
const COMPRESSION_RAW = 0;
const COMPRESSION_ZSTD = 1;
const PROTECTION_CHECKSUM = 0;
const PROTECTION_AES_256_GCM = 1;
const CHECKSUM_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const UUID_BYTES = 16;
const SHA256_BYTES = 32;
const MAX_SPLIT_FILES = 100_000;
const MAX_PIECES_PER_FILE = 100_000;
const MAX_PATH_BYTES = 4096;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export interface ExtendedSharePiece {
    sourceIndex: number;
    remoteFileId: Buffer;
    offset: number;
    length: number;
    remoteOffset?: number;
}

export interface ExtendedShareSplitFile {
    path: string;
    size: number;
    sha256?: Buffer;
    pieces: ExtendedSharePiece[];
}

export interface ExtendedSharePayload {
    collectionIds: Buffer[];
    splitFiles: ExtendedShareSplitFile[];
}

export async function encodeExtendedShare(
    payload: ExtendedSharePayload,
    password?: string,
): Promise<string> {
    const normalized = requireExtendedSharePayload(payload);
    const raw = Buffer.from(
        encode([
            normalized.collectionIds,
            normalized.splitFiles.map((file) => [
                file.path,
                file.size,
                file.sha256 ?? null,
                file.pieces.map((piece) => [
                    piece.sourceIndex,
                    piece.remoteFileId,
                    piece.offset,
                    piece.length,
                    ...(piece.remoteOffset ? [piece.remoteOffset] : []),
                ]),
            ]),
        ]),
    );
    if (raw.length > MAX_EXTENDED_SHARE_DECOMPRESSED_BYTES) {
        throw new Error("Extended share payload is too large.");
    }

    const compressed = compressZstdSync(raw);
    const compression = compressed.length < raw.length ? COMPRESSION_ZSTD : COMPRESSION_RAW;
    const body = compression === COMPRESSION_ZSTD ? compressed : raw;
    const protection = password ? PROTECTION_AES_256_GCM : PROTECTION_CHECKSUM;
    const header = Buffer.from([EXTENDED_SHARE_VERSION, compression, protection, 0]);
    const envelope = password
        ? await encryptBody(header, body, password)
        : Buffer.concat([
              header,
              body,
              createHash("sha256").update(header).update(body).digest().subarray(0, CHECKSUM_BYTES),
          ]);

    if (envelope.length > MAX_EXTENDED_SHARE_ENCODED_BYTES) {
        throw new Error("Extended share payload is too large.");
    }
    return formatExtendedShareString(envelope);
}

/** Frame a KDE1 share string as a .kds binary file (magic + sha256 + envelope). */
export function encodeExtendedShareFile(shareValue: string): Buffer {
    const envelope = parseExtendedShareEnvelope(shareValue);
    const checksum = createHash("sha256").update(envelope).digest();
    return Buffer.concat([KDS_MAGIC, checksum, envelope]);
}

/** Decode a .kds file back to the KDE1 share string used by the existing load pipeline. */
export function decodeExtendedShareFile(raw: Buffer): string {
    if (raw.length > KDS_HEADER_SIZE + MAX_EXTENDED_SHARE_ENCODED_BYTES) {
        throw new Error("Extended share file is too large.");
    }
    if (
        raw.length < KDS_HEADER_SIZE + HEADER_BYTES ||
        !raw.subarray(0, KDS_MAGIC.length).equals(KDS_MAGIC)
    ) {
        throw new Error("Invalid extended share file.");
    }
    const expected = raw.subarray(KDS_MAGIC.length, KDS_HEADER_SIZE);
    const envelope = raw.subarray(KDS_HEADER_SIZE);
    const actual = createHash("sha256").update(envelope).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new Error("Extended share file is corrupted.");
    }
    if (envelope.length > MAX_EXTENDED_SHARE_ENCODED_BYTES || envelope.length < HEADER_BYTES) {
        throw new Error("Invalid extended share file.");
    }
    requireHeader(envelope.subarray(0, HEADER_BYTES));
    return formatExtendedShareString(envelope);
}

export function isExtendedShareFile(raw: Buffer): boolean {
    return raw.length >= KDS_MAGIC.length && raw.subarray(0, KDS_MAGIC.length).equals(KDS_MAGIC);
}

export async function decodeExtendedShare(
    input: string,
    password?: string,
): Promise<ExtendedSharePayload> {
    const envelope = parseExtendedShareEnvelope(input);
    const header = envelope.subarray(0, HEADER_BYTES);
    requireHeader(header);
    const body =
        header[2] === PROTECTION_AES_256_GCM
            ? await decryptBody(header, envelope.subarray(HEADER_BYTES), password)
            : verifyChecksum(header, envelope.subarray(HEADER_BYTES));

    let cbor: Buffer;
    try {
        cbor =
            header[1] === COMPRESSION_ZSTD
                ? decompressZstdSync(body, {
                      maxOutputLength: MAX_EXTENDED_SHARE_DECOMPRESSED_BYTES,
                  })
                : body;
    } catch {
        throw new Error("Invalid extended share information.");
    }
    if (cbor.length > MAX_EXTENDED_SHARE_DECOMPRESSED_BYTES) {
        throw new Error("Extended share payload is too large.");
    }

    let decoded: unknown;
    try {
        decoded = decode(cbor);
    } catch {
        throw new Error("Invalid extended share information.");
    }
    return requireCompactPayload(decoded);
}

function formatExtendedShareString(envelope: Buffer) {
    return `${EXTENDED_SHARE_PREFIX}${envelope.toString("base64url")}`;
}

function parseExtendedShareEnvelope(input: string): Buffer {
    if (!input.startsWith(EXTENDED_SHARE_PREFIX)) {
        throw new Error("Invalid extended share information.");
    }

    const encoded = input.slice(EXTENDED_SHARE_PREFIX.length);
    if (
        encoded.length === 0 ||
        encoded.length > Math.ceil((MAX_EXTENDED_SHARE_ENCODED_BYTES * 4) / 3) ||
        !/^[A-Za-z0-9_-]+$/.test(encoded)
    ) {
        throw new Error("Invalid extended share information.");
    }

    const envelope = Buffer.from(encoded, "base64url");
    if (
        envelope.length > MAX_EXTENDED_SHARE_ENCODED_BYTES ||
        envelope.toString("base64url") !== encoded ||
        envelope.length < HEADER_BYTES
    ) {
        throw new Error("Invalid extended share information.");
    }
    return envelope;
}

function requireHeader(header: Buffer) {
    if (header[0] !== EXTENDED_SHARE_VERSION) {
        throw new Error(`Unsupported extended share version: ${String(header[0])}.`);
    }
    if (header[1] !== COMPRESSION_RAW && header[1] !== COMPRESSION_ZSTD) {
        throw new Error("Unsupported extended share compression algorithm.");
    }
    if (header[2] !== PROTECTION_CHECKSUM && header[2] !== PROTECTION_AES_256_GCM) {
        throw new Error("Unsupported extended share protection algorithm.");
    }
    if (header[3] !== 0) {
        throw new Error("Unsupported extended share header.");
    }
}

async function encryptBody(header: Buffer, body: Buffer, password: string) {
    const salt = randomBytes(SALT_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", await deriveKey(password, salt), nonce);
    cipher.setAAD(header);
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([header, salt, nonce, encrypted, cipher.getAuthTag()]);
}

async function decryptBody(header: Buffer, body: Buffer, password?: string) {
    if (!password) {
        throw new Error(EXTENDED_SHARE_PASSWORD_REQUIRED_ERROR);
    }
    if (body.length < SALT_BYTES + NONCE_BYTES + TAG_BYTES) {
        throw new Error("Invalid extended share information.");
    }

    const salt = body.subarray(0, SALT_BYTES);
    const nonce = body.subarray(SALT_BYTES, SALT_BYTES + NONCE_BYTES);
    const tag = body.subarray(body.length - TAG_BYTES);
    const encrypted = body.subarray(SALT_BYTES + NONCE_BYTES, body.length - TAG_BYTES);
    try {
        const decipher = createDecipheriv("aes-256-gcm", await deriveKey(password, salt), nonce);
        decipher.setAAD(header);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch {
        throw new Error(EXTENDED_SHARE_INVALID_PASSWORD_ERROR);
    }
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, KEY_BYTES, SCRYPT_OPTIONS, (error, key) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(key);
        });
    });
}

function verifyChecksum(header: Buffer, body: Buffer) {
    if (body.length < CHECKSUM_BYTES) {
        throw new Error("Invalid extended share information.");
    }
    const payload = body.subarray(0, body.length - CHECKSUM_BYTES);
    const expected = body.subarray(body.length - CHECKSUM_BYTES);
    const actual = createHash("sha256")
        .update(header)
        .update(payload)
        .digest()
        .subarray(0, CHECKSUM_BYTES);
    if (!timingSafeEqual(expected, actual)) {
        throw new Error("Corrupted extended share information.");
    }
    return payload;
}

function requireCompactPayload(input: unknown): ExtendedSharePayload {
    if (!Array.isArray(input) || input.length !== 2) {
        throw new Error("Invalid extended share payload.");
    }
    return requireExtendedSharePayload({
        collectionIds: input[0],
        splitFiles: Array.isArray(input[1])
            ? input[1].map((file) => {
                  if (!Array.isArray(file) || file.length !== 4) {
                      throw new Error("Invalid extended share payload.");
                  }
                  return {
                      path: file[0],
                      size: file[1],
                      sha256: file[2],
                      pieces: Array.isArray(file[3])
                          ? file[3].map((piece) => {
                                if (
                                    !Array.isArray(piece) ||
                                    (piece.length !== 4 && piece.length !== 5)
                                ) {
                                    throw new Error("Invalid extended share payload.");
                                }
                                return {
                                    sourceIndex: piece[0],
                                    remoteFileId: piece[1],
                                    offset: piece[2],
                                    length: piece[3],
                                    ...(piece.length === 5 ? { remoteOffset: piece[4] } : {}),
                                };
                            })
                          : file[3],
                  };
              })
            : input[1],
    });
}

function requireExtendedSharePayload(input: unknown): ExtendedSharePayload {
    if (
        !isRecord(input) ||
        !Array.isArray(input.collectionIds) ||
        !Array.isArray(input.splitFiles)
    ) {
        throw new Error("Invalid extended share payload.");
    }
    if (input.collectionIds.length === 0) {
        throw new Error("Invalid extended share payload.");
    }
    if (input.splitFiles.length > MAX_SPLIT_FILES) {
        throw new Error("Invalid extended share payload.");
    }

    const collectionIds = input.collectionIds.map((id) => requireBytes(id, UUID_BYTES));
    const paths = new Set<string>();
    const splitFiles = input.splitFiles.map((file) => {
        const size = isRecord(file) ? file.size : undefined;
        if (
            !isRecord(file) ||
            typeof file.path !== "string" ||
            file.path.length === 0 ||
            Buffer.byteLength(file.path) > MAX_PATH_BYTES ||
            !isNonNegativeSafeInteger(size) ||
            !Array.isArray(file.pieces) ||
            file.pieces.length === 0 ||
            file.pieces.length > MAX_PIECES_PER_FILE ||
            paths.has(file.path)
        ) {
            throw new Error("Invalid extended share payload.");
        }
        paths.add(file.path);

        let nextOffset = 0;
        const pieceCount = file.pieces.length;
        const pieces = file.pieces.map((piece) => {
            if (
                !isRecord(piece) ||
                !isNonNegativeSafeInteger(piece.sourceIndex) ||
                piece.sourceIndex >= collectionIds.length ||
                !isNonNegativeSafeInteger(piece.offset) ||
                piece.offset !== nextOffset ||
                !isNonNegativeSafeInteger(piece.length) ||
                (piece.remoteOffset != null && !isNonNegativeSafeInteger(piece.remoteOffset)) ||
                (piece.length === 0 && (size !== 0 || pieceCount !== 1)) ||
                piece.length > size - piece.offset
            ) {
                throw new Error("Invalid extended share payload.");
            }
            nextOffset += piece.length;
            return {
                sourceIndex: piece.sourceIndex,
                remoteFileId: requireBytes(piece.remoteFileId, UUID_BYTES),
                offset: piece.offset,
                length: piece.length,
                ...(piece.remoteOffset ? { remoteOffset: piece.remoteOffset } : {}),
            };
        });
        if (nextOffset !== size) {
            throw new Error("Invalid extended share payload.");
        }
        return {
            path: file.path,
            size,
            ...(file.sha256 == null ? {} : { sha256: requireBytes(file.sha256, SHA256_BYTES) }),
            pieces,
        };
    });
    return { collectionIds, splitFiles };
}

function requireBytes(input: unknown, length: number) {
    if (!(input instanceof Uint8Array) || input.byteLength !== length) {
        throw new Error("Invalid extended share payload.");
    }
    return Buffer.from(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null;
}

function isNonNegativeSafeInteger(input: unknown): input is number {
    return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}
