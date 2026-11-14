import { createCipheriv, createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";

import { type MegaLink, tryParseMegaUrl } from "@shared/share-url";

import { base64urlDecode } from "../download/transfer-it-crypto";

// MegaDownloader `enc?`/`enc2?` link constants (URLExtractor.vb, Criptografia.vb).
const ENCODE_PASSWORD = "k1o6Al-1kz¿!z05y";
const ENCODE_PASSWORD2 = "nYrXa@9Q¿1&hCWM\\9(731Bp?t42=!k3.";
const ENC_XOR = [12, 57, 251, 120, 18, 75, 6, 250, 85];
const ENC_LEGACY_IV = Buffer.from([
    121, 241, 10, 1, 132, 74, 11, 39, 255, 91, 45, 78, 14, 211, 22, 62,
]);

const MAC_LAST_GROWING_CHUNK = 8;
const MAC_CHUNK_UNIT = 128 * 1024;
const MAC_CHUNK_MAX = 1024 * 1024;

/** Decrypts a folder-link node key (16 or 32 bytes) with the folder master key (AES-128-ECB). */
export function decryptMegaNodeKey(encryptedKeyB64: string, folderKey: Buffer) {
    const encrypted = base64urlDecode(encryptedKeyB64);
    if (encrypted.length !== 16 && encrypted.length !== 32) {
        throw new Error(`Invalid encrypted node key length ${encrypted.length}.`);
    }
    const decipher = createDecipheriv("aes-128-ecb", folderKey, null);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function megaFileAesKey(key32: Buffer) {
    const aesKey = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
        aesKey[i] = key32[i]! ^ key32[16 + i]!;
    }
    return aesKey;
}

export class MegaMacMismatchError extends Error {
    public constructor(filePath: string) {
        super(`Downloaded file failed MEGA integrity verification: ${filePath}`);
        this.name = "MegaMacMismatchError";
    }
}

/**
 * Computes the condensed MEGA file MAC (8 bytes) of a plaintext file: CBC-MAC per MEGA chunk
 * (128K, 256K, ... 1M, then 1M each) with IV `nonce || nonce`, chained through AES with a zero IV.
 */
export async function computeMegaMetaMac(filePath: string, key32: Buffer, signal?: AbortSignal) {
    const aesKey = megaFileAesKey(key32);
    const nonce = key32.subarray(16, 24);
    const chunkIv = Buffer.concat([nonce, nonce]);
    const fileMac = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16));
    fileMac.setAutoPadding(false);
    let lastFileMacBlock = Buffer.alloc(16);

    const handle = await fs.open(filePath, "r");
    try {
        const buffer = Buffer.alloc(MAC_CHUNK_MAX);
        let position = 0;
        for (let chunkNumber = 1; ; chunkNumber += 1) {
            signal?.throwIfAborted();
            const chunkSize =
                chunkNumber <= MAC_LAST_GROWING_CHUNK
                    ? chunkNumber * MAC_CHUNK_UNIT
                    : MAC_CHUNK_MAX;
            const { bytesRead } = await readFully(handle, buffer, chunkSize, position);
            if (bytesRead === 0) {
                break;
            }
            position += bytesRead;
            const padded = Math.ceil(bytesRead / 16) * 16;
            buffer.fill(0, bytesRead, padded);
            const chunkMac = createCipheriv("aes-128-cbc", aesKey, chunkIv);
            chunkMac.setAutoPadding(false);
            const out = chunkMac.update(buffer.subarray(0, padded));
            lastFileMacBlock = fileMac.update(out.subarray(out.length - 16));
            if (bytesRead < chunkSize) {
                break;
            }
        }
    } finally {
        await handle.close();
    }

    const condensed = Buffer.alloc(8);
    for (let i = 0; i < 4; i++) {
        condensed[i] = lastFileMacBlock[i]! ^ lastFileMacBlock[4 + i]!;
        condensed[4 + i] = lastFileMacBlock[8 + i]! ^ lastFileMacBlock[12 + i]!;
    }
    return condensed;
}

export async function verifyMegaFileMac(filePath: string, key32: Buffer, signal?: AbortSignal) {
    const mac = await computeMegaMetaMac(filePath, key32, signal);
    if (!mac.equals(key32.subarray(24, 32))) {
        throw new MegaMacMismatchError(filePath);
    }
}

async function readFully(handle: fs.FileHandle, buffer: Buffer, length: number, position: number) {
    let bytesRead = 0;
    while (bytesRead < length) {
        const result = await handle.read(
            buffer,
            bytesRead,
            length - bytesRead,
            position + bytesRead,
        );
        if (result.bytesRead === 0) {
            break;
        }
        bytesRead += result.bytesRead;
    }
    return { bytesRead };
}

/**
 * Resolves a MegaDownloader `enc`/`enc2`/`fenc`/`fenc2` link to a public link. Like the original,
 * the v1 key is tried first and the v2 key when v1 does not yield a valid link.
 */
export function decodeMegaEncodedLink(link: Extract<MegaLink, { type: "encoded" }>) {
    const data = Buffer.from(link.payload.replaceAll(",", ""), "base64url");
    for (const key of [encodeKey(ENCODE_PASSWORD), encodeKeyV2()]) {
        const plain = decryptEncodedPayload(data, key);
        if (!plain) {
            continue;
        }
        const body = `${link.kind === "folder" ? "F" : ""}${plain}`;
        const parsed = tryParseMegaUrl(body.startsWith("mega:") ? body : `mega://#${body}`);
        if (parsed?.type === "public") {
            return parsed;
        }
    }
    throw new Error("Invalid encoded Mega link.");
}

function encodeKey(password: string) {
    const padded = password.slice(0, 32).padEnd(32, "X");
    // .NET ASCII encoding replaces non-ASCII characters (e.g. "¿") with "?".
    return Buffer.from(
        Array.from(padded, (char) => (char.charCodeAt(0) > 0x7f ? 0x3f : char.charCodeAt(0))),
    );
}

function encodeKeyV2() {
    const key = encodeKey(ENCODE_PASSWORD2);
    for (let i = 0; i < 160; i++) {
        key[i % key.length] = key[i % key.length]! ^ ENC_XOR[i % ENC_XOR.length]!;
    }
    return key;
}

function decryptEncodedPayload(data: Buffer, key: Buffer) {
    const hasIv = data.length > 17 && data.length % 16 === 1 && data[0] === 1;
    const iv = hasIv ? data.subarray(1, 17) : ENC_LEGACY_IV;
    const cipher = hasIv ? data.subarray(17) : data;
    try {
        const decipher = createDecipheriv("aes-256-cbc", key, iv);
        return Buffer.concat([decipher.update(cipher), decipher.final()])
            .toString("latin1")
            .replaceAll("\u0000", "");
    } catch {
        return null;
    }
}
