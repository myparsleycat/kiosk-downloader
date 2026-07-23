import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import fse from "fs-extra";
import pLimit from "p-limit";

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
    algorithm: "sha256-size-greedy",
    hash: "sha256",
    maxPackBytes: SMALL_FILE_PACK_BYTES,
    maxEntryBytes: SMALL_FILE_PACK_ENTRY_MAX_BYTES,
    concat: "raw",
} as const;

const HASH_CONCURRENCY = 2;
const RECIPE_DOMAIN = "KDE-PACK-RECIPE-V2";

export function isPackCandidate(file: Pick<PersistedBundleFile, "size" | "logicalSize">) {
    return file.logicalSize === file.size && file.size < SMALL_FILE_PACK_ENTRY_MAX_BYTES;
}

/**
 * Globally pack whole small files by content hash + size (path-independent membership/order).
 * Non-candidates pass through unchanged. Call before collection bin-packing.
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

    const sorted = candidates.toSorted(comparePackCandidates);
    const groups: PersistedBundleFile[][] = [];
    for (const file of sorted) {
        const group = groups.at(-1);
        const groupSize = group?.reduce((sum, candidate) => sum + candidate.size, 0) ?? 0;
        if (!group || groupSize + file.size > SMALL_FILE_PACK_BYTES) {
            groups.push([file]);
        } else {
            group.push(file);
        }
    }

    const packed = groups.flatMap((group): PersistedBundleFile[] => {
        if (group.length === 1) return group;

        const ordered = group.toSorted(comparePackConcatOrder);
        let remoteOffset = 0;
        const packEntries = ordered.map((file) => {
            const entry: PersistedBundlePackEntry = {
                fsPath: file.fsPath,
                sourceMtimeMs: file.sourceMtimeMs,
                path: file.logicalPath ?? file.path,
                size: file.size,
                remoteOffset,
                contentSha256: file.logicalSha256,
            };
            remoteOffset += file.size;
            return entry;
        });

        const recipeId = computePackRecipeId(packEntries);
        const physicalPath = `kde_pack_v2/${recipeId}`;
        return [
            {
                path: physicalPath,
                name: path.basename(physicalPath),
                size: remoteOffset,
                fsPath: path.join(packDir, `${recipeId}.pack`),
                sourceMtimeMs: 0,
                sourceOffset: 0,
                logicalPath: physicalPath,
                logicalSize: remoteOffset,
                packEntries,
            },
        ];
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
) {
    const unique = [...new Set(filePaths)];
    const limit = pLimit(concurrency);
    const entries = await Promise.all(
        unique.map((filePath) => limit(async () => [filePath, await hashFile(filePath)] as const)),
    );
    return new Map(entries);
}

function comparePackCandidates(left: PersistedBundleFile, right: PersistedBundleFile) {
    if (left.size !== right.size) return right.size - left.size;
    const leftHash = left.logicalSha256 ?? "";
    const rightHash = right.logicalSha256 ?? "";
    if (leftHash !== rightHash) return leftHash < rightHash ? -1 : 1;
    return 0;
}

function comparePackConcatOrder(left: PersistedBundleFile, right: PersistedBundleFile) {
    const leftHash = left.logicalSha256 ?? "";
    const rightHash = right.logicalSha256 ?? "";
    if (leftHash !== rightHash) return leftHash < rightHash ? -1 : 1;
    if (left.size !== right.size) return left.size - right.size;
    return 0;
}

function computePackRecipeId(entries: PersistedBundlePackEntry[]) {
    const hash = createHash("sha256");
    hash.update(RECIPE_DOMAIN);
    hash.update(Buffer.from([0]));
    for (const entry of entries) {
        hash.update(Buffer.from(entry.contentSha256 ?? "", "hex"));
        const size = Buffer.alloc(8);
        size.writeBigUInt64BE(BigInt(entry.size));
        hash.update(size);
    }
    return hash.digest("hex");
}
