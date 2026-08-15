import fse from "fs-extra";

import type { DownloadRepository } from "./repository";
import type { TransferItApiClient } from "./transfer-it-api-client";
import type { DownloadChunkRow, DownloadCollectionRow, DownloadFileRow } from "./types";

import { PartFileWriter } from "./part-file";
import { parseTransferNodeKey, type TransferChunkPool } from "./transfer-chunk-pool";

type TransferItDownloadRunnerDeps = {
    api: TransferItApiClient;
    repository: DownloadRepository;
    transferPool: TransferChunkPool;
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

export type TransferItDownloadRunInput = {
    collection: DownloadCollectionRow;
    file: DownloadFileRow;
    controller: AbortController;
    maxChunkRetries: number;
    priority: number;
    startedAt: number;
    collectionStartedAt: number;
};

export class TransferItDownloadRunner {
    private readonly collectionAuth = new Map<string, string | undefined>();

    public constructor(private readonly deps: TransferItDownloadRunnerDeps) {}

    public clearCollection(collectionId: string) {
        this.collectionAuth.delete(collectionId);
    }

    public destroy() {
        this.collectionAuth.clear();
    }

    public async runFile(input: TransferItDownloadRunInput) {
        const partPath = this.deps.getPartPath(input.collection, input.file);
        if (this.deps.repository.reconcileTransferChunkLayout(input.file.id)) {
            await fse.remove(partPath).catch(() => undefined);
            await PartFileWriter.removeSidecar(partPath);
        }

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

        const partWriter = new PartFileWriter(this.deps.getPartPath(collection, file));

        try {
            await partWriter.open(file.size, refreshedChunks.length);
            const outcome = await this.deps.transferPool.register({
                collection,
                file,
                nodeKey: parseTransferNodeKey(file.sourceMetaJson),
                authPw: this.getAuth(collection),
                partWriter,
                controller: input.controller,
                maxChunkRetries: input.maxChunkRetries,
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

    private getAuth(collection: DownloadCollectionRow) {
        if (this.collectionAuth.has(collection.id)) {
            return this.collectionAuth.get(collection.id);
        }
        const authPw = this.deps.api.deriveAuthPw(collection);
        this.collectionAuth.set(collection.id, authPw);
        return authPw;
    }
}

function isActiveFileDownloadStatus(status: DownloadFileRow["status"] | undefined) {
    return status === "downloading" || status === "inflating";
}

function areChunksComplete(chunks: DownloadChunkRow[]) {
    return chunks.length > 0 && chunks.every((chunk) => chunk.status === "completed");
}
