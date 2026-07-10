import type { FileHandle } from "node:fs/promises";
import fsp from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";

import fse from "fs-extra";

const CRC_BYTES = 4;
const CRC_LEGACY = 0;

type ChunkRange = {
    chunkIndex: number;
    offset: number;
    size: number;
};

export function getPartDigestPath(partPath: string) {
    return `${partPath}.crc`;
}

/** Staging file for deflate compressed payload (`file.part` → `file.part.z`). */
export function getStagingPartPath(partPath: string) {
    return `${partPath}.z`;
}

export class PartFileWriter {
    private handle: FileHandle | null = null;
    private digestHandle: FileHandle | null = null;

    public constructor(private readonly partPath: string) {}

    public async open(fileSize: number, chunkCount: number) {
        await fse.ensureDir(path.dirname(this.partPath));
        try {
            this.handle = await fsp.open(this.partPath, "r+");
        } catch {
            this.handle = await fsp.open(this.partPath, "w+");
        }
        const partStat = await this.handle.stat();
        if (partStat.size > fileSize) {
            await this.handle.truncate(fileSize);
        }

        const digestPath = getPartDigestPath(this.partPath);
        try {
            this.digestHandle = await fsp.open(digestPath, "r+");
        } catch {
            this.digestHandle = await fsp.open(digestPath, "w+");
        }
        const digestSize = chunkCount * CRC_BYTES;
        const digestStat = await this.digestHandle.stat();
        if (digestStat.size > digestSize) {
            await this.digestHandle.truncate(digestSize);
        }
    }

    public writeAt(offset: number, buffer: Buffer, chunkIndex: number) {
        return this.writeAtInternal(offset, buffer, chunkIndex);
    }

    public async writeChunkFromStream(
        offset: number,
        chunkIndex: number,
        source: AsyncIterable<Uint8Array>,
        expectedSize: number,
        streamWriteBatchBytes: number,
        callbacks?: {
            onTransferProgress?: (transferredBytes: number) => void;
            onWriteProgress?: (writtenBytes: number) => void;
        },
        options?: { alreadyWritten?: number },
    ) {
        const alreadyWritten = Math.max(
            0,
            Math.min(expectedSize, Math.floor(options?.alreadyWritten ?? 0)),
        );
        let transferred = 0;
        let written = alreadyWritten;
        let crc = alreadyWritten > 0 ? await this.readCrcSeed(offset, alreadyWritten) : 0;
        const pending: Uint8Array[] = [];
        let pendingBytes = 0;

        for await (const piece of source) {
            const remaining = expectedSize - written - pendingBytes;
            if (remaining <= 0) {
                break;
            }

            const slice = piece.length > remaining ? piece.subarray(0, remaining) : piece;
            pending.push(slice);
            pendingBytes += slice.length;
            transferred += slice.length;
            callbacks?.onTransferProgress?.(transferred);

            while (pendingBytes >= streamWriteBatchBytes) {
                const batch = takePendingBatch(pending, streamWriteBatchBytes);
                pendingBytes -= batch.length;
                const writeOffset = offset + written;
                await this.writePartialInternal(writeOffset, batch);
                crc = crc32(batch, crc);
                written += batch.length;
                callbacks?.onWriteProgress?.(written - alreadyWritten);
            }

            if (written + pendingBytes >= expectedSize) {
                break;
            }
        }

        if (pendingBytes > 0) {
            const batch = takePendingBatch(pending, pendingBytes);
            await this.writePartialInternal(offset + written, batch);
            crc = crc32(batch, crc);
            written += batch.length;
            callbacks?.onWriteProgress?.(written - alreadyWritten);
        }

        if (written < expectedSize) {
            throw new Error(
                `Segment ${chunkIndex} returned ${written - alreadyWritten}B, expected ${expectedSize - alreadyWritten}B.`,
            );
        }

        await this.writeDigestInternal(chunkIndex, crc >>> 0);
        return written;
    }

    public async close() {
        await this.handle?.close();
        this.handle = null;
        await this.digestHandle?.close();
        this.digestHandle = null;
    }

    public static async isChunkValid(partPath: string, chunk: ChunkRange) {
        let partHandle: FileHandle;
        try {
            partHandle = await fsp.open(partPath, "r");
        } catch {
            return false;
        }

        try {
            const expectedDigest = await readExpectedDigest(partPath, chunk.chunkIndex);
            if (expectedDigest === null || expectedDigest === CRC_LEGACY) {
                return hasLegacyRange(partPath, chunk);
            }

            const chunkBuffer = Buffer.alloc(chunk.size);
            const readResult = await partHandle.read(chunkBuffer, 0, chunk.size, chunk.offset);
            if (readResult.bytesRead !== chunk.size) {
                return false;
            }
            return toUnsignedCrc32(chunkBuffer) === expectedDigest;
        } finally {
            await partHandle.close();
        }
    }

    public static async removeSidecar(partPath: string) {
        await fse.remove(getPartDigestPath(partPath)).catch(() => undefined);
    }

    private async writeAtInternal(offset: number, buffer: Buffer, chunkIndex: number) {
        await this.writePartialInternal(offset, buffer);
        await this.writeDigestInternal(chunkIndex, toUnsignedCrc32(buffer));
    }

    private async writePartialInternal(offset: number, buffer: Uint8Array) {
        if (!this.handle) {
            throw new Error("Part file is not open.");
        }

        await this.handle.write(buffer, 0, buffer.length, offset);
    }

    private async writeDigestInternal(chunkIndex: number, digest: number) {
        if (!this.digestHandle) {
            throw new Error("Part file is not open.");
        }

        const digestBuffer = Buffer.allocUnsafe(CRC_BYTES);
        digestBuffer.writeUInt32BE(digest, 0);
        await this.digestHandle.write(digestBuffer, 0, CRC_BYTES, chunkIndex * CRC_BYTES);
    }

    private async readCrcSeed(offset: number, length: number) {
        if (!this.handle) {
            throw new Error("Part file is not open.");
        }

        let crc = 0;
        let readOffset = offset;
        let remaining = length;
        const buffer = Buffer.allocUnsafe(Math.min(remaining, 1024 * 1024));

        while (remaining > 0) {
            const toRead = Math.min(remaining, buffer.length);
            const result = await this.handle.read(buffer, 0, toRead, readOffset);
            if (result.bytesRead !== toRead) {
                throw new Error(
                    `Part file is shorter than resume offset: expected ${toRead}B at ${readOffset}, got ${result.bytesRead}B.`,
                );
            }
            crc = crc32(buffer.subarray(0, toRead), crc);
            readOffset += toRead;
            remaining -= toRead;
        }

        return crc;
    }
}

async function readExpectedDigest(partPath: string, chunkIndex: number) {
    const digestPath = getPartDigestPath(partPath);
    let digestHandle: FileHandle;
    try {
        digestHandle = await fsp.open(digestPath, "r");
    } catch {
        return null;
    }

    try {
        const digestBuffer = Buffer.alloc(CRC_BYTES);
        const readResult = await digestHandle.read(
            digestBuffer,
            0,
            CRC_BYTES,
            chunkIndex * CRC_BYTES,
        );
        if (readResult.bytesRead < CRC_BYTES) {
            return null;
        }
        return digestBuffer.readUInt32BE(0);
    } finally {
        await digestHandle.close();
    }
}

async function hasLegacyRange(partPath: string, chunk: ChunkRange) {
    try {
        const stat = await fse.stat(partPath);
        return stat.size >= chunk.offset + chunk.size;
    } catch {
        return false;
    }
}

function toUnsignedCrc32(buffer: Buffer) {
    return crc32(buffer) >>> 0;
}

function takePendingBatch(pending: Uint8Array[], bytes: number) {
    if (pending.length === 1 && pending[0]?.length === bytes) {
        return pending.shift() as Uint8Array;
    }

    const batch = Buffer.allocUnsafe(bytes);
    let copied = 0;
    while (copied < bytes) {
        const head = pending.shift();
        if (!head) {
            throw new Error("Pending stream buffer is shorter than expected.");
        }

        const remaining = bytes - copied;
        if (head.length <= remaining) {
            batch.set(head, copied);
            copied += head.length;
            continue;
        }

        batch.set(head.subarray(0, remaining), copied);
        pending.unshift(head.subarray(remaining));
        copied += remaining;
    }

    return batch;
}
