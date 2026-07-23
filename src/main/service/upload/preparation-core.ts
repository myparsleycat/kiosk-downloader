import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import {
    createExtendedUploadPieces,
    EXTENDED_UPLOAD_DEFAULT_LIMITS,
    packSizedItems,
} from "@shared/extended-upload-plan";

import type { PreparationProgressHandler } from "./preparation-protocol";
import type { UploadSourceFile } from "./types";

import {
    createDeterministicPackArtifacts,
    isPackCandidate,
    materializeSmallFilePack,
    PACK_ALGORITHM_VERSION,
    PACK_POLICY_V2,
    type PersistedBundleFile,
    type PersistedBundlePlan,
} from "./small-file-pack";
import { isKioskCompatiblePath } from "./upload-path";

const HASH_CONCURRENCY = 2;

export class PlanProgressReporter {
    private lastSentAt = 0;
    private lastStage: string | undefined;
    private lastSignature = "";

    constructor(
        private readonly handler: PreparationProgressHandler,
        private readonly minIntervalMs = 100,
    ) {}

    report(progress: Parameters<PreparationProgressHandler>[0], force = false) {
        const now = performance.now();
        const stageChanged = progress.stage !== this.lastStage;
        const isFinal = progress.stage !== "hashing" || progress.current === progress.total;
        const signature = `${progress.stage}:${progress.current}:${progress.total}:${progress.processedBytes ?? ""}`;
        const duplicate = signature === this.lastSignature;

        if (!force && duplicate) return;
        if (!force && !stageChanged && !isFinal && now - this.lastSentAt < this.minIntervalMs) {
            return;
        }
        this.lastSentAt = now;
        this.lastStage = progress.stage;
        this.lastSignature = signature;
        this.handler(progress);
    }
}

export async function planIntegratedBundle(
    files: UploadSourceFile[],
    bundleId: string,
    packDir: string,
    reporter: PlanProgressReporter,
): Promise<PersistedBundlePlan> {
    const sourcesByPath = new Map(files.map((file) => [file.path, file]));
    const pieces = createExtendedUploadPieces(files, "integrated");

    const hashPaths = new Set<string>();
    let totalBytes = 0;
    for (const piece of pieces) {
        const source = sourcesByPath.get(piece.sourcePath);
        if (!source) {
            throw new Error(`업로드 원본 경로를 찾을 수 없습니다: ${piece.sourcePath}`);
        }
        const needsLogicalHash =
            piece.pieceCount > 1 ||
            isPackCandidate({ size: piece.length, logicalSize: piece.sourceSize }) ||
            !isKioskCompatiblePath(piece.sourcePath);
        if (needsLogicalHash && !hashPaths.has(source.fsPath)) {
            hashPaths.add(source.fsPath);
            totalBytes += source.size;
        }
    }

    reporter.report(
        {
            stage: "hashing",
            current: 0,
            total: hashPaths.size,
            processedBytes: 0,
            totalBytes,
        },
        true,
    );

    const hashesByFsPath = await hashFilesBoundedProgress(hashPaths, (current, processedBytes) => {
        reporter.report({
            stage: "hashing",
            current,
            total: hashPaths.size,
            processedBytes,
            totalBytes,
        });
    });

    const hashesByLogicalPath = new Map<string, string>();
    for (const file of files) {
        const digest = hashesByFsPath.get(file.fsPath);
        if (digest) hashesByLogicalPath.set(file.path, digest);
    }

    reporter.report({ stage: "packing", current: 0, total: 1 }, true);

    const physicalFiles: PersistedBundleFile[] = pieces.map((piece) => {
        const source = sourcesByPath.get(piece.sourcePath);
        if (!source) {
            throw new Error(`업로드 원본 경로를 찾을 수 없습니다: ${piece.sourcePath}`);
        }
        return pieceToPersistedFile(
            source,
            piece,
            bundleId,
            hashesByLogicalPath.get(piece.sourcePath),
        );
    });

    const artifacts = createDeterministicPackArtifacts(physicalFiles, packDir);

    reporter.report({ stage: "packing", current: 1, total: 1 }, true);

    const collections = packSizedItems(
        artifacts.map((file) => ({
            ...file,
            size: file.size,
            sortKey: file.packEntries
                ? `pack:${file.path}`
                : `direct:${file.logicalPath ?? file.path}:${file.sourceOffset ?? 0}:${file.size}`,
        })),
        EXTENDED_UPLOAD_DEFAULT_LIMITS,
    );

    return {
        version: PACK_ALGORITHM_VERSION,
        packPolicy: { ...PACK_POLICY_V2 },
        collections: collections.map((collection) => ({
            files: collection.items.map(({ sortKey: _sortKey, ...file }) => file),
        })),
    };
}

export async function materializePacks(files: PersistedBundleFile[]): Promise<UploadSourceFile[]> {
    const prepared: UploadSourceFile[] = [];
    for (const file of files) {
        if (!file.packEntries) {
            prepared.push(file);
            continue;
        }
        prepared.push(await materializeSmallFilePack(file));
    }
    return prepared;
}

async function hashFileStream(
    filePath: string,
    onChunk: (chunkBytes: number) => void,
): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) {
        const buffer = chunk as Buffer;
        hash.update(buffer);
        onChunk(buffer.length);
    }
    return hash.digest("hex");
}

async function hashFilesBoundedProgress(
    filePaths: Iterable<string>,
    onProgress: (done: number, processedBytes: number) => void,
    concurrency = HASH_CONCURRENCY,
): Promise<Map<string, string>> {
    const unique = [...new Set(filePaths)];
    const total = unique.length;
    if (total === 0) {
        onProgress(0, 0);
        return new Map<string, string>();
    }

    const results = new Map<string, string>();
    let cursor = 0;
    let done = 0;
    let processedBytes = 0;
    const workerCount = Math.min(concurrency, total);
    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (true) {
                const index = cursor++;
                const filePath = unique[index];
                if (filePath === undefined) return;
                results.set(
                    filePath,
                    await hashFileStream(filePath, (chunkBytes) => {
                        processedBytes += chunkBytes;
                        onProgress(done, processedBytes);
                    }),
                );
                done += 1;
                onProgress(done, processedBytes);
            }
        }),
    );
    return results;
}

export function pieceToPersistedFile(
    source: UploadSourceFile,
    piece: {
        sourcePath: string;
        sourceSize: number;
        sourceIndex: number;
        pieceIndex: number;
        pieceCount: number;
        offset: number;
        length: number;
    },
    bundleId: string,
    logicalSha256?: string,
): PersistedBundleFile {
    const physicalPath =
        piece.pieceCount === 1
            ? piece.sourcePath
            : `.__kde_${bundleId}/${piece.sourceIndex}.${piece.pieceIndex}`;
    return {
        ...source,
        path: physicalPath,
        name: physicalPath.slice(physicalPath.lastIndexOf("/") + 1),
        size: piece.length,
        sourceOffset: piece.offset,
        logicalPath: piece.sourcePath,
        logicalSize: piece.sourceSize,
        logicalSha256,
    };
}
