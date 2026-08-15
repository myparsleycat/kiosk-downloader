import type { KioApiClient } from "./kio-api-client";
import type { DownloadRepository } from "./repository";
import type { GlobalSegmentPool } from "./segment-pool";
import type { DownloadChunkRow, DownloadCollectionRow, DownloadFileRow } from "./types";

import { PartFileWriter } from "./part-file";

type KioskDownloadRunnerDeps = {
    api: KioApiClient;
    repository: DownloadRepository;
    segmentPool: GlobalSegmentPool;
    runControl: <T>(task: () => Promise<T>) => Promise<T>;
    getPartPath: (collection: DownloadCollectionRow, file: DownloadFileRow) => string;
    validateCompletedChunks: (
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        chunks: DownloadChunkRow[],
    ) => Promise<void>;
    finalizeFile: (
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        signal?: AbortSignal,
    ) => Promise<void>;
    markProgress: (collectionId: string, fileId: string) => void;
};

export type KioskDownloadRunInput = {
    collection: DownloadCollectionRow;
    file: DownloadFileRow;
    controller: AbortController;
    maxChunkRetries: number;
    streamWriteBatchBytes: number;
    priority: number;
    startedAt: number;
    collectionStartedAt: number;
};

export class KioskDownloadRunner {
    private readonly collectionTokens = new Map<string, string>();

    public constructor(private readonly deps: KioskDownloadRunnerDeps) {}

    public clearCollection(collectionId: string) {
        this.collectionTokens.delete(collectionId);
    }

    public destroy() {
        this.collectionTokens.clear();
    }

    public async runFile(input: KioskDownloadRunInput) {
        const chunks = this.deps.repository.listChunks(input.file.id);
        await this.deps.validateCompletedChunks(input.collection, input.file, chunks);
        this.deps.repository.syncFileDownloadedBytes(input.file.id);

        const file = this.deps.repository.getFile(input.file.id);
        const collection = this.deps.repository.getCollection(input.collection.id);
        if (!file || !collection) {
            return;
        }

        const refreshedChunks = this.deps.repository.listChunks(file.id);
        if (file.size === 0 || areChunksComplete(refreshedChunks)) {
            await this.deps.finalizeFile(collection, file);
            return;
        }

        const segments = await this.getFileSegments(collection, file, input.controller.signal);
        const partWriter = new PartFileWriter(this.deps.getPartPath(collection, file));

        try {
            await partWriter.open(file.size, refreshedChunks.length);
            const outcome = await this.deps.segmentPool.register({
                collection,
                file,
                segments,
                partWriter,
                controller: input.controller,
                maxChunkRetries: input.maxChunkRetries,
                streamWriteBatchBytes: input.streamWriteBatchBytes,
                priority: input.priority,
                chunks: refreshedChunks.filter(
                    (chunk) => chunk.status === "pending" || chunk.status === "error",
                ),
                startedAt: input.startedAt,
                collectionStartedAt: input.collectionStartedAt,
            });

            if (outcome === "paused") {
                if (!this.deps.repository.hasErroredChunk(file.id)) {
                    const currentFile = this.deps.repository.getFile(file.id);
                    if (isActiveFileDownloadStatus(currentFile?.status)) {
                        this.deps.repository.markFileStatus(file.id, "pending");
                        this.deps.markProgress(collection.id, file.id);
                    }
                }
                return;
            }
            if (outcome === "failed") {
                return;
            }
            if (areChunksComplete(this.deps.repository.listChunks(file.id))) {
                await this.deps.finalizeFile(collection, file);
            }
        } finally {
            await partWriter.close();
        }
    }

    public async getFileSegments(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        signal: AbortSignal,
    ) {
        return await this.deps.runControl(async () => {
            throwIfAborted(signal);
            const cachedToken = this.collectionTokens.get(collection.id);
            const cat = cachedToken ?? (await this.refreshCollectionToken(collection));
            throwIfAborted(signal);
            return await this.deps.api.getSegments(file.remoteId, cat);
        });
    }

    private async refreshCollectionToken(collection: DownloadCollectionRow) {
        const refreshed = await this.deps.api.refreshCollectionToken(collection);
        this.deps.repository.updateCollectionFreshMeta(collection.id, {
            expires: refreshed.expires,
        });
        this.collectionTokens.set(collection.id, refreshed.cat);
        return refreshed.cat;
    }
}

function isActiveFileDownloadStatus(status: DownloadFileRow["status"] | undefined) {
    return status === "downloading" || status === "inflating";
}

function areChunksComplete(chunks: DownloadChunkRow[]) {
    return chunks.length > 0 && chunks.every((chunk) => chunk.status === "completed");
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
    }
}
