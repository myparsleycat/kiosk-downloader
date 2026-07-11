import { promisify } from "node:util";
import {
    zstdCompress as zstdCompressCb,
    zstdCompressSync,
    zstdDecompress as zstdDecompressCb,
    zstdDecompressSync,
} from "node:zlib";
import type { ZstdOptions } from "node:zlib";

export function compressZstdSync(data: Buffer): Buffer {
    return zstdCompressSync(data);
}

export function decompressZstdSync(data: Buffer, options?: ZstdOptions): Buffer {
    return zstdDecompressSync(data, options);
}

export async function compressZstd(data: Buffer): Promise<Buffer> {
    return promisify(zstdCompressCb)(data);
}

export async function decompressZstd(data: Buffer, options?: ZstdOptions): Promise<Buffer> {
    return promisify(zstdDecompressCb)(data, options);
}
