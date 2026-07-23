import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import fse from "fs-extra";

import type { UploadSourceFile } from "./types";

export type PersistedBundlePackEntry = {
    fsPath: string;
    sourceMtimeMs: number;
    path: string;
    size: number;
    remoteOffset: number;
};

export type PersistedBundleFile = UploadSourceFile & {
    packEntries?: PersistedBundlePackEntry[];
};

export type PersistedBundlePlan = {
    collections: Array<{ files: PersistedBundleFile[] }>;
};

export const SMALL_FILE_PACK_BYTES = 100 * 1024 ** 2;

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
            await pipeline(
                createReadStream(entry.fsPath),
                createWriteStream(tempPath, { flags: index === 0 ? "w" : "a" }),
            );
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
