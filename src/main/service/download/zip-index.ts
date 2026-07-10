import { ZIP_INVALID_PASSWORD_ERROR, ZIP_PASSWORD_REQUIRED_ERROR } from "@shared/download-errors";
import type { TreeEntry } from "@shared/types";
import { buildZipEntriesTree, type IndexedZipEntry } from "@shared/zip-tree";
import {
    configure,
    ERR_ENCRYPTED,
    ERR_INVALID_PASSWORD,
    Reader,
    Uint8ArrayWriter,
    ZipReader,
    type Entry,
    type FileEntry,
} from "@zip.js/zip.js";

import type { KioskDownloader } from "../..";
import type { SegmentDescriptor } from "./types";

import { ZipRangeReader } from "./zip-range-reader";

configure({ useWebWorkers: false });

export type ZipIndexResult = {
    entries: TreeEntry[];
    indexed: IndexedZipEntry[];
    zipPassword?: string;
};

type CacheEntry = ZipIndexResult & { cachedAt: number };

const indexCache = new Map<string, CacheEntry>();

function cacheKey(shareId: string, remoteFileId: string) {
    return `${shareId}:${remoteFileId}`;
}

export function clearZipIndexCache(shareId?: string) {
    if (!shareId) {
        indexCache.clear();
        return;
    }
    const prefix = `${shareId}:`;
    for (const key of indexCache.keys()) {
        if (key.startsWith(prefix)) {
            indexCache.delete(key);
        }
    }
}

export function getCachedZipIndex(shareId: string, remoteFileId: string) {
    return indexCache.get(cacheKey(shareId, remoteFileId)) ?? null;
}

class SegmentBackedZipReader extends Reader<null> {
    public size: number;

    public constructor(private readonly rangeReader: ZipRangeReader) {
        super(null);
        this.size = rangeReader.size;
    }

    public async readUint8Array(index: number, length: number) {
        return this.rangeReader.readUint8Array(index, length);
    }
}

function toIndexedEntry(entry: Entry): IndexedZipEntry {
    const filename = entry.filename.replace(/\\/g, "/");
    return {
        path: filename,
        name: filename.split("/").filter(Boolean).at(-1) ?? filename,
        directory: entry.directory,
        offset: entry.offset,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        compressionMethod: entry.compressionMethod,
        encrypted: entry.encrypted,
    };
}

async function verifyZipPassword(entries: Entry[], password: string | undefined) {
    const protectedEntry = entries.find(
        (entry): entry is FileEntry => !entry.directory && entry.encrypted,
    );
    if (!protectedEntry) {
        return;
    }
    if (!password) {
        throw new Error(ZIP_PASSWORD_REQUIRED_ERROR);
    }
    try {
        await protectedEntry.getData(new Uint8ArrayWriter(), {
            password,
            checkPasswordOnly: true,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
            message.includes(ERR_INVALID_PASSWORD) ||
            message.includes("Invalid password") ||
            message.includes(ERR_ENCRYPTED)
        ) {
            throw new Error(ZIP_INVALID_PASSWORD_ERROR);
        }
        throw error;
    }
}

export async function indexZipFromSegments(options: {
    kd: KioskDownloader;
    shareId: string;
    remoteFileId: string;
    segments: SegmentDescriptor[];
    segmentSize: number;
    fileSize: number;
    zipPassword?: string;
    signal?: AbortSignal;
    bypassCache?: boolean;
}): Promise<ZipIndexResult> {
    const key = cacheKey(options.shareId, options.remoteFileId);
    if (!options.bypassCache) {
        const cached = indexCache.get(key);
        if (cached && (!options.zipPassword || cached.zipPassword === options.zipPassword)) {
            if (!cached.indexed.some((entry) => entry.encrypted) || cached.zipPassword) {
                return cached;
            }
        }
    }

    const rangeReader = new ZipRangeReader({
        kd: options.kd,
        segments: options.segments,
        segmentSize: options.segmentSize,
        fileSize: options.fileSize,
        signal: options.signal,
    });
    const zipReader = new ZipReader(new SegmentBackedZipReader(rangeReader), {
        password: options.zipPassword,
    });

    try {
        const entries = await zipReader.getEntries();
        const needsPassword = entries.some((entry) => !entry.directory && entry.encrypted);
        if (needsPassword && !options.zipPassword) {
            throw new Error(ZIP_PASSWORD_REQUIRED_ERROR);
        }
        await verifyZipPassword(entries, options.zipPassword);

        const indexed = entries.map(toIndexedEntry);
        const result: ZipIndexResult = {
            entries: buildZipEntriesTree(options.remoteFileId, indexed),
            indexed,
            zipPassword: options.zipPassword,
        };
        indexCache.set(key, { ...result, cachedAt: Date.now() });
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === ZIP_PASSWORD_REQUIRED_ERROR || message === ZIP_INVALID_PASSWORD_ERROR) {
            throw error;
        }
        if (message.includes(ERR_ENCRYPTED) || message.includes("Encrypted")) {
            throw new Error(ZIP_PASSWORD_REQUIRED_ERROR);
        }
        if (message.includes(ERR_INVALID_PASSWORD) || message.includes("Invalid password")) {
            throw new Error(ZIP_INVALID_PASSWORD_ERROR);
        }
        throw error;
    } finally {
        await zipReader.close();
    }
}

export async function openZipFileEntry(options: {
    kd: KioskDownloader;
    segments: SegmentDescriptor[];
    segmentSize: number;
    fileSize: number;
    entryPath: string;
    zipPassword?: string;
    signal?: AbortSignal;
}): Promise<{ entry: FileEntry; zipReader: ZipReader<null>; rangeReader: ZipRangeReader }> {
    const rangeReader = new ZipRangeReader({
        kd: options.kd,
        segments: options.segments,
        segmentSize: options.segmentSize,
        fileSize: options.fileSize,
        signal: options.signal,
    });
    const zipReader = new ZipReader(new SegmentBackedZipReader(rangeReader), {
        password: options.zipPassword,
    });
    const entries = await zipReader.getEntries();
    const entry = entries.find(
        (candidate): candidate is FileEntry =>
            !candidate.directory &&
            candidate.filename.replace(/\\/g, "/").replace(/\/+$/, "") === options.entryPath,
    );
    if (!entry) {
        await zipReader.close();
        throw new Error(`ZIP entry not found: ${options.entryPath}`);
    }
    return { entry, zipReader, rangeReader };
}
