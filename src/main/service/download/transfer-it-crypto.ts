import { createDecipheriv, pbkdf2Sync } from "node:crypto";

import { COLLECTION_EXPIRES_NEVER } from "@shared/download-errors";

/** Dummy segment size stored for transfer collections (chunks use MEGA schedule). */
export const TRANSFER_SEGMENT_SIZE = 1024 * 1024;

export { COLLECTION_EXPIRES_NEVER };

export function base64urlDecode(data: string) {
    let normalized = String(data).replace(/-/g, "+").replace(/_/g, "/").replace(/,/g, "");
    normalized += "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(normalized, "base64");
}

export function base64urlEncode(buf: Buffer) {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function deriveTransferPassword(xh: string, password: string) {
    const decoded = base64urlDecode(xh);
    const tail =
        xh.length > 12
            ? base64urlDecode(decoded.toString("binary")).subarray(-7, -1).toString("binary")
            : decoded.subarray(-6).toString("binary");
    const salt = Buffer.from(tail.repeat(3), "binary");
    const key = pbkdf2Sync(Buffer.from(password.trim(), "utf8"), salt, 100_000, 32, "sha256");
    return base64urlEncode(key);
}

function a32(buf: Buffer) {
    let padded = buf;
    const pad = (4 - (buf.length & 3)) & 3;
    if (pad) {
        padded = Buffer.concat([buf, Buffer.alloc(pad, 0)]);
    }
    const out: number[] = [];
    for (let i = 0; i < padded.length; i += 4) {
        out.push(padded.readUInt32BE(i) >>> 0);
    }
    return out;
}

function a32buf(values: number[]) {
    const buf = Buffer.alloc(values.length * 4);
    for (let i = 0; i < values.length; i++) {
        buf.writeUInt32BE(values[i]! >>> 0, i * 4);
    }
    return buf;
}

/** Decrypt MEGA node attributes. Supports 16-byte (folder) and 32-byte (file) keys. */
export function decryptNodeAttr(attrB64: string, keyBytes: Buffer): { n?: string } | null {
    const keyA32 = a32(keyBytes);
    while (keyA32.length < 8) {
        keyA32.push(0);
    }
    const cbcKey = a32buf([
        (keyA32[0]! ^ keyA32[4]!) >>> 0,
        (keyA32[1]! ^ keyA32[5]!) >>> 0,
        (keyA32[2]! ^ keyA32[6]!) >>> 0,
        (keyA32[3]! ^ keyA32[7]!) >>> 0,
    ]);
    const attr = base64urlDecode(attrB64);
    const dec = createDecipheriv("aes-128-cbc", cbcKey, Buffer.alloc(16, 0));
    dec.setAutoPadding(false);
    // MEGA attrs are null-padded; strip NULs after decode.
    const plain = Buffer.concat([dec.update(attr), dec.final()])
        .toString("utf8")
        .replaceAll("\u0000", "");
    if (!plain.startsWith("MEGA")) {
        return null;
    }
    try {
        return JSON.parse(plain.slice(4)) as { n?: string };
    } catch {
        return null;
    }
}

function incrementCtrBuffer(buf: Buffer, cnt: number) {
    let remaining = cnt;
    let i = buf.length - 1;
    while (remaining !== 0) {
        const mod = (remaining + buf[i]!) % 256;
        remaining = Math.floor((remaining + buf[i]!) / 256);
        buf[i] = mod;
        i -= 1;
        if (i < 0) {
            i = buf.length - 1;
        }
    }
}

/** Decrypt a MEGA AES-128-CTR file chunk. `key32` must be 32 bytes. */
export function decryptTransferChunk(key32: Buffer, start: number, enc: Buffer) {
    if (key32.length !== 32) {
        throw new Error(`Invalid transfer file key length ${key32.length} (expected 32).`);
    }
    const aesKey = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
        aesKey[i] = key32[i]! ^ key32[16 + i]!;
    }
    const iv = Buffer.alloc(16);
    key32.subarray(16, 24).copy(iv, 0);
    if (start !== 0) {
        incrementCtrBuffer(iv, start / 16);
    }
    const dec = createDecipheriv("aes-128-ctr", aesKey, iv);
    return Buffer.concat([dec.update(enc), dec.final()]);
}

/** MEGA download chunk schedule (128KiB ramp → 1MiB). */
export function megaChunkSizes(fileSize: number, maxChunk = 1024 * 1024) {
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
        return [] as { start: number; size: number }[];
    }
    const chunks: { start: number; size: number }[] = [];
    let p = 0;
    for (let i = 1; i <= 8 && p < fileSize - i * 131072; i++) {
        chunks.push({ start: p, size: i * 131072 });
        p += i * 131072;
    }
    while (p < fileSize) {
        const size = Math.min(maxChunk, fileSize - p);
        chunks.push({ start: p, size });
        p += size;
    }
    return chunks;
}

export function decodeTransferTitle(encoded: string | undefined, fallback: string) {
    if (!encoded) {
        return fallback;
    }
    try {
        const decoded = base64urlDecode(encoded).toString("utf8").replaceAll("\u0000", "").trim();
        return decoded || fallback;
    } catch {
        return fallback;
    }
}
