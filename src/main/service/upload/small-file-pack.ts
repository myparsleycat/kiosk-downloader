import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import fse from "fs-extra";

import type { UploadSourceFile } from "./types";

export type PersistedBundlePackEntry = {
    fsPath: string;
    sourceMtimeMs: number;
    path: string;
    size: number;
    remoteOffset: number;
    contentSha256?: string;
};

export type PersistedBundleFile = UploadSourceFile & {
    packEntries?: PersistedBundlePackEntry[];
};

export type PersistedBundlePlan = {
    version?: number;
    packPolicy?: {
        algorithm: string;
        hash: string;
        maxPackBytes: number;
        maxEntryBytes: number;
        concat: string;
    };
    collections: Array<{ files: PersistedBundleFile[] }>;
};

/** Max bytes per physical pack (inclusive). */
export const SMALL_FILE_PACK_BYTES = 100 * 1024 ** 2;

/**
 * Whole files at or above this size stay direct uploads (exclusive).
 * Matches upload segment size so full-segment objects are not multi-file packed.
 */
export const SMALL_FILE_PACK_ENTRY_MAX_BYTES = 16 * 1024 ** 2;

export const PACK_ALGORITHM_VERSION = 2;

export const PACK_POLICY_V2 = {
    algorithm: "sha256-prefix-trie",
    hash: "sha256",
    maxPackBytes: SMALL_FILE_PACK_BYTES,
    maxEntryBytes: SMALL_FILE_PACK_ENTRY_MAX_BYTES,
    concat: "raw",
} as const;

const HASH_CONCURRENCY = 2;
const RECIPE_DOMAIN = "KDE-PACK-RECIPE-V2";
const PLACEMENT_DOMAIN = "KDE-PACK-V2";
const MAX_TRIE_DEPTH = 256;

type PackInstance = {
    file: PersistedBundleFile;
    contentSha256: string;
    occurrence: number;
    placementKey: Buffer;
};

export function isPackCandidate(file: Pick<PersistedBundleFile, "size" | "logicalSize">) {
    return file.logicalSize === file.size && file.size < SMALL_FILE_PACK_ENTRY_MAX_BYTES;
}

/**
 * Globally pack whole small files via content-addressed hash-prefix trie.
 * Membership/order depend on (sha256, size, multiplicity), not paths or collections.
 * Call before collection bin-packing.
 */
export function createDeterministicPackArtifacts(
    files: PersistedBundleFile[],
    packDir: string,
): PersistedBundleFile[] {
    const direct: PersistedBundleFile[] = [];
    const candidates: PersistedBundleFile[] = [];

    for (const file of files) {
        if (!isPackCandidate(file) || !file.logicalSha256) {
            direct.push(file);
            continue;
        }
        candidates.push(file);
    }

    const instances = assignPackInstances(candidates);
    const totalBytes = instances.reduce((sum, instance) => sum + instance.file.size, 0);
    const leaves = partitionByHashPrefix(instances, 0, totalBytes);
    const packed = leaves.flatMap((leaf): PersistedBundleFile[] => {
        if (leaf.length === 1) return [leaf[0]!.file];
        return [materializePackArtifact(leaf, packDir)];
    });

    return [...direct, ...packed];
}

/** @deprecated Use createDeterministicPackArtifacts before collection packing. Kept for v1 plan resume only. */
export function createSmallFilePackPlan(
    plan: PersistedBundlePlan,
    bundleId: string,
    packDir: string,
): PersistedBundlePlan {
    return {
        collections: plan.collections.map((collection, ordinal) => {
            const direct = collection.files.filter(
                (file) => file.logicalSize !== file.size || file.size > SMALL_FILE_PACK_BYTES,
            );
            const small = collection.files.filter(
                (file) => file.logicalSize === file.size && file.size <= SMALL_FILE_PACK_BYTES,
            );
            const groups: PersistedBundleFile[][] = [];
            for (const file of small) {
                const group = groups.at(-1);
                const groupSize = group?.reduce((sum, candidate) => sum + candidate.size, 0) ?? 0;
                if (!group || groupSize + file.size > SMALL_FILE_PACK_BYTES) {
                    groups.push([file]);
                } else {
                    group.push(file);
                }
            }

            const packed = groups.flatMap((group, packIndex): PersistedBundleFile[] => {
                if (group.length === 1) return group;
                let remoteOffset = 0;
                const packEntries = group.map((file) => {
                    const entry = {
                        fsPath: file.fsPath,
                        sourceMtimeMs: file.sourceMtimeMs,
                        path: file.logicalPath ?? file.path,
                        size: file.size,
                        remoteOffset,
                    };
                    remoteOffset += file.size;
                    return entry;
                });
                const physicalPath = `kde_${bundleId.replaceAll("-", "")}/pack_${ordinal}_${packIndex}`;
                return [
                    {
                        path: physicalPath,
                        name: path.basename(physicalPath),
                        size: remoteOffset,
                        fsPath: path.join(packDir, `${ordinal}_${packIndex}.pack`),
                        sourceMtimeMs: 0,
                        sourceOffset: 0,
                        logicalPath: physicalPath,
                        logicalSize: remoteOffset,
                        packEntries,
                    },
                ];
            });
            return { files: [...direct, ...packed] };
        }),
    };
}

export async function materializeSmallFilePack(
    file: PersistedBundleFile,
): Promise<UploadSourceFile> {
    if (!file.packEntries) return file;
    const tempPath = `${file.fsPath}.tmp`;
    await fse.ensureDir(path.dirname(file.fsPath));
    await fse.remove(tempPath);
    try {
        for (const [index, entry] of file.packEntries.entries()) {
            const stat = await fse.stat(entry.fsPath);
            if (stat.size !== entry.size || Math.trunc(stat.mtimeMs) !== entry.sourceMtimeMs) {
                throw new Error(`업로드 원본 파일이 변경되었습니다: ${entry.path}`);
            }
            const hash = createHash("sha256");
            await pipeline(
                createReadStream(entry.fsPath),
                new Transform({
                    transform(chunk, _encoding, callback) {
                        hash.update(chunk as Buffer);
                        callback(null, chunk);
                    },
                }),
                createWriteStream(tempPath, { flags: index === 0 ? "w" : "a" }),
            );
            if (entry.contentSha256 && hash.digest("hex") !== entry.contentSha256) {
                throw new Error(`업로드 원본 파일 내용이 변경되었습니다: ${entry.path}`);
            }
            const after = await fse.stat(entry.fsPath);
            if (after.size !== entry.size || Math.trunc(after.mtimeMs) !== entry.sourceMtimeMs) {
                throw new Error(`업로드 중 원본 파일이 변경되었습니다: ${entry.path}`);
            }
        }
        const stat = await fse.stat(tempPath);
        if (stat.size !== file.size) throw new Error("작은 파일 묶음 크기가 일치하지 않습니다.");
        await fse.move(tempPath, file.fsPath, { overwrite: true });
        return { ...file, sourceMtimeMs: Math.trunc((await fse.stat(file.fsPath)).mtimeMs) };
    } catch (error) {
        await fse.remove(tempPath);
        throw error;
    }
}

export async function hashFilesBounded(
    filePaths: Iterable<string>,
    hashFile: (filePath: string) => Promise<string>,
    concurrency = HASH_CONCURRENCY,
    onProgress?: (done: number, total: number) => void,
) {
    const unique = [...new Set(filePaths)];
    const total = unique.length;
    onProgress?.(0, total);
    if (total === 0) return new Map<string, string>();

    const results = new Map<string, string>();
    let cursor = 0;
    let done = 0;
    const workerCount = Math.min(concurrency, total);
    // Fixed worker pool: only `workerCount` closures exist at once, so a corpus
    // near the manifest limit does not materialize one promise per file up front.
    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (true) {
                const index = cursor++;
                const filePath = unique[index];
                if (filePath === undefined) return;
                results.set(filePath, await hashFile(filePath));
                done += 1;
                onProgress?.(done, total);
            }
        }),
    );
    return results;
}

function assignPackInstances(candidates: PersistedBundleFile[]): PackInstance[] {
    const byIdentity = new Map<string, PersistedBundleFile[]>();
    for (const file of candidates) {
        const key = `${file.logicalSha256}\0${file.size}`;
        const group = byIdentity.get(key) ?? [];
        group.push(file);
        byIdentity.set(key, group);
    }

    const instances: PackInstance[] = [];
    for (const group of byIdentity.values()) {
        const ordered = group.toSorted((left, right) => {
            const leftPath = left.logicalPath ?? left.path;
            const rightPath = right.logicalPath ?? right.path;
            if (leftPath === rightPath) return 0;
            return compareUtf8(leftPath, rightPath);
        });
        for (const [occurrence, file] of ordered.entries()) {
            const contentSha256 = file.logicalSha256!;
            instances.push({
                file,
                contentSha256,
                occurrence,
                placementKey: computePlacementKey(contentSha256, file.size, occurrence),
            });
        }
    }
    return instances;
}

function partitionByHashPrefix(
    instances: PackInstance[],
    depth: number,
    totalBytes: number,
): PackInstance[][] {
    if (instances.length === 0) return [];
    if (totalBytes <= SMALL_FILE_PACK_BYTES) return [instances];
    // Guard the pack cap as a hard invariant even on a (cryptographically
    // improbable) placement-key collision at the full 256-bit depth: fall back
    // to direct uploads rather than emit an oversized leaf.
    if (depth >= MAX_TRIE_DEPTH) return instances.map((instance) => [instance]);

    const zero: PackInstance[] = [];
    const one: PackInstance[] = [];
    let zeroBytes = 0;
    let oneBytes = 0;
    for (const instance of instances) {
        if (getPlacementBit(instance.placementKey, depth) === 0) {
            zero.push(instance);
            zeroBytes += instance.file.size;
        } else {
            one.push(instance);
            oneBytes += instance.file.size;
        }
    }

    // A shared prefix bit is normal, not a collision — keep descending into the
    // non-empty side. Only a fully-exhausted digest at MAX_TRIE_DEPTH forces a
    // multi-instance leaf, which is unreachable for unique placement keys.
    if (zero.length === 0) return partitionByHashPrefix(one, depth + 1, oneBytes);
    if (one.length === 0) return partitionByHashPrefix(zero, depth + 1, zeroBytes);

    return [
        ...partitionByHashPrefix(zero, depth + 1, zeroBytes),
        ...partitionByHashPrefix(one, depth + 1, oneBytes),
    ];
}

function materializePackArtifact(leaf: PackInstance[], packDir: string): PersistedBundleFile {
    const ordered = leaf.toSorted((left, right) => left.placementKey.compare(right.placementKey));
    let remoteOffset = 0;
    const packEntries = ordered.map((instance) => {
        const entry: PersistedBundlePackEntry = {
            fsPath: instance.file.fsPath,
            sourceMtimeMs: instance.file.sourceMtimeMs,
            path: instance.file.logicalPath ?? instance.file.path,
            size: instance.file.size,
            remoteOffset,
            contentSha256: instance.contentSha256,
        };
        remoteOffset += instance.file.size;
        return entry;
    });

    const recipeId = computePackRecipeId(
        ordered.map((instance) => ({
            contentSha256: instance.contentSha256,
            size: instance.file.size,
            occurrence: instance.occurrence,
        })),
    );
    const physicalPath = `kde_pack_v2/${recipeId}`;
    return {
        path: physicalPath,
        name: path.basename(physicalPath),
        size: remoteOffset,
        fsPath: path.join(packDir, `${recipeId}.pack`),
        sourceMtimeMs: 0,
        sourceOffset: 0,
        logicalPath: physicalPath,
        logicalSize: remoteOffset,
        packEntries,
    };
}

function computePlacementKey(contentSha256: string, size: number, occurrence: number) {
    const hash = createHash("sha256");
    hash.update(PLACEMENT_DOMAIN);
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(contentSha256, "hex"));
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeBigUInt64BE(BigInt(size));
    hash.update(sizeBuf);
    const occBuf = Buffer.alloc(4);
    occBuf.writeUInt32BE(occurrence);
    hash.update(occBuf);
    return hash.digest();
}

function getPlacementBit(placementKey: Buffer, bitIndex: number) {
    const byte = placementKey[Math.floor(bitIndex / 8)] ?? 0;
    return (byte >> (7 - (bitIndex % 8))) & 1;
}

function computePackRecipeId(
    entries: Array<{ contentSha256: string; size: number; occurrence: number }>,
) {
    const hash = createHash("sha256");
    hash.update(RECIPE_DOMAIN);
    hash.update(Buffer.from([0]));
    for (const entry of entries) {
        hash.update(Buffer.from(entry.contentSha256, "hex"));
        const size = Buffer.alloc(8);
        size.writeBigUInt64BE(BigInt(entry.size));
        hash.update(size);
        const occ = Buffer.alloc(4);
        occ.writeUInt32BE(entry.occurrence);
        hash.update(occ);
    }
    return hash.digest("hex");
}

function compareUtf8(left: string, right: string) {
    const leftBytes = Buffer.from(left, "utf8");
    const rightBytes = Buffer.from(right, "utf8");
    return leftBytes.compare(rightBytes);
}
