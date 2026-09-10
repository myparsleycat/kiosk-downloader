import type { KioApiClient } from "./kio-api-client";
import type { DownloadRepository } from "./repository";
import type { GlobalSegmentPool } from "./segment-pool";
import type { DownloadChunkRow, DownloadCollectionRow, DownloadFileRow } from "./types";

import { CborHttpError } from "../../lib/http-error";
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
    private readonly tokenRefreshes = new Map<
        string,
        { signal: AbortSignal; promise: Promise<string> }
    >();

    public constructor(private readonly deps: KioskDownloadRunnerDeps) {}

    public clearCollection(collectionId: string) {
        this.collectionTokens.delete(collectionId);
        this.tokenRefreshes.delete(collectionId);
    }

    public destroy() {
        this.collectionTokens.clear();
        this.tokenRefreshes.clear();
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
            for (let attempt = 0; ; attempt++) {
                throwIfAborted(signal);
                const cat = await this.getCollectionToken(collection, signal);
                throwIfAborted(signal);

                try {
                    const segments = await this.deps.api.getSegments(file.remoteId, cat, signal);
                    throwIfAborted(signal);
                    return segments;
                } catch (error) {
                    throwIfAborted(signal);
                    if (!(error instanceof CborHttpError) || error.status !== 401) throw error;
                    // A late 401 must not invalidate a newer token another file already obtained.
                    if (this.collectionTokens.get(collection.id) === cat) {
                        this.collectionTokens.delete(collection.id);
                    }
                    if (attempt > 0) throw error;
                }
            }
        });
    }

    private getCollectionToken(collection: DownloadCollectionRow, signal: AbortSignal) {
        return (
            this.collectionTokens.get(collection.id) ??
            this.refreshCollectionToken(collection, signal)
        );
    }

    private async refreshCollectionToken(
        collection: DownloadCollectionRow,
        signal: AbortSignal,
    ): Promise<string> {
        throwIfAborted(signal);
        const inFlight = this.tokenRefreshes.get(collection.id);
        if (inFlight && !inFlight.signal.aborted) {
            let onAbort: () => void = () => undefined;
            const aborted = new Promise<never>((_resolve, reject) => {
                onAbort = () =>
                    reject(new DOMException("The operation was aborted.", "AbortError"));
                signal.addEventListener("abort", onAbort, { once: true });
            });
            try {
                return await Promise.race([inFlight.promise, aborted]);
            } catch (error) {
                throwIfAborted(signal);
                if (!inFlight.signal.aborted) throw error;
                // Pausing the file that owns the refresh must not pause its siblings.
                return await this.refreshCollectionToken(collection, signal);
            } finally {
                signal.removeEventListener("abort", onAbort);
            }
        }

        const refresh = {
            signal,
            promise: this.deps.api.refreshCollectionToken(collection, signal).then((refreshed) => {
                throwIfAborted(signal);
                if (this.tokenRefreshes.get(collection.id) !== refresh) {
                    throw new DOMException(
                        "The collection token refresh was cleared.",
                        "AbortError",
                    );
                }
                this.deps.repository.updateCollectionFreshMeta(collection.id, {
                    expires: refreshed.expires,
                });
                this.collectionTokens.set(collection.id, refreshed.cat);
                return refreshed.cat;
            }),
        };
        this.tokenRefreshes.set(collection.id, refresh);

        try {
            return await refresh.promise;
        } finally {
            if (this.tokenRefreshes.get(collection.id) === refresh) {
                this.tokenRefreshes.delete(collection.id);
            }
        }
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
