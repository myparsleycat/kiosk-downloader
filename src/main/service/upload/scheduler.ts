import { performance } from "node:perf_hooks";

import { toErrorMessage } from "@shared/utils";

import type { KioskDownloader } from "../..";
import type { UploadTransferMetrics } from "./metrics";
import type { UploadRepository } from "./repository";
import type {
    SchedulerSettings,
    ServerFileMapping,
    UploadChunkRow,
    UploadCollectionRow,
    UploadFileRow,
} from "./types";

import { TransferProgressBatcher } from "../transfer-progress-batcher";
import {
    KioUploadClient,
    UploadSessionExpiredError,
    UploadSourceChangedError,
} from "./kio-upload-client";

const MAX_UPLOAD_IN_FLIGHT_SEGMENTS = 8;
const STALL_TIMEOUT_MS = 15_000;
const MAX_SLOW_RECONNECTS = 2;

type PendingChunk = ServerFileMapping & {
    collectionId: string;
    localFileId: string;
    generation: number;
};

type FileWorkState = {
    collectionId: string;
    fileId: string;
    chunks: ServerFileMapping[];
    completed: Set<number>;
    queued: Set<number>;
    inFlightSequences: Set<number>;
    inFlight: number;
    generation: number;
    paused: boolean;
    failed: boolean;
    completionPersisted: boolean;
    controller: AbortController;
};

type CollectionWorkState = {
    fileIds: Set<string>;
    unfinishedFileIds: Set<string>;
    activeFileIds: Set<string>;
    inFlight: number;
    failed: boolean;
    completing: boolean;
};

function chunkBackoffMs(attempt: number) {
    return 1000 * 2 ** (attempt - 1);
}

function isAbortError(error: unknown) {
    return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}

function sleepWithAbort(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

export class UploadScheduler {
    private readonly queue: PendingChunk[] = [];
    private readonly collections = new Map<string, CollectionWorkState>();
    private readonly files = new Map<string, FileWorkState>();
    private readonly waiters: Array<() => void> = [];
    private readonly activeCollections = new Set<string>();
    private readonly collectionTimerStartedAt = new Map<string, number>();
    private readonly progressBatcher: TransferProgressBatcher;
    private targetWorkers = 0;
    private runningWorkers = 0;

    public constructor(
        private readonly kd: KioskDownloader,
        private readonly api: KioUploadClient,
        private readonly repository: UploadRepository,
        private readonly metrics: UploadTransferMetrics,
        private readonly emitUpdate: (collectionId?: string) => Promise<void>,
        emitProgressUpdate: (collectionId: string, fileIds: Set<string>) => Promise<void>,
    ) {
        this.progressBatcher = new TransferProgressBatcher(
            async (collectionId, fileIds) => {
                await emitProgressUpdate(collectionId, fileIds);
                const activeFileIds = this.collections.get(collectionId)?.activeFileIds;
                if (!activeFileIds || activeFileIds.size === 0) {
                    this.progressBatcher.deactivate(collectionId);
                    return;
                }
                let hasRunnable = false;
                for (const fileId of activeFileIds) {
                    const file = this.files.get(fileId);
                    if (!file || file.paused) {
                        continue;
                    }
                    hasRunnable = true;
                    this.progressBatcher.mark(collectionId, fileId);
                }
                if (!hasRunnable) {
                    this.progressBatcher.deactivate(collectionId);
                }
            },
            (error) => {
                this.kd.logger.error(error, "UploadScheduler:pollProgressUpdates");
            },
        );
    }

    public hasActiveTransfers() {
        return this.activeCollections.size > 0;
    }

    public getCollectionElapsedMs(collectionId: string) {
        const persistedMs = this.repository.getCollectionElapsedMs(collectionId);
        const startedAt = this.collectionTimerStartedAt.get(collectionId);
        return startedAt === undefined
            ? persistedMs
            : persistedMs + Math.max(0, performance.now() - startedAt);
    }

    public registerWorkItems(
        collectionId: string,
        fileRows: { id: string; remoteId: string }[],
        workItems: ServerFileMapping[],
    ) {
        const fileByRemoteId = new Map(fileRows.map((file) => [file.remoteId, file.id]));
        const chunksByFile = new Map<string, ServerFileMapping[]>();
        for (const item of workItems) {
            const fileId = fileByRemoteId.get(item.fileId.toString("hex"));
            if (!fileId) {
                throw new Error(
                    `서버 파일 ID가 로컬 파일과 일치하지 않습니다: ${item.relativePath}`,
                );
            }
            const chunks = chunksByFile.get(fileId) ?? [];
            chunks.push(item);
            chunksByFile.set(fileId, chunks);
        }
        if (chunksByFile.size !== fileRows.length) {
            throw new Error("모든 업로드 파일의 청크 작업을 만들지 못했습니다.");
        }
        this.registerCollection(collectionId, chunksByFile);
    }

    public async restoreFromRepository() {
        for (const collection of this.repository.listRunnableCollections()) {
            this.restoreCollection(collection);
        }
    }

    public async schedule() {
        const settings = await this.getSettings();
        this.resize(settings.maxWorkers);
        for (const collection of this.repository.listRunnableCollections()) {
            const state = this.collections.get(collection.id) ?? this.restoreCollection(collection);
            if (!state || state.failed || state.completing) {
                continue;
            }
            for (const fileId of state.unfinishedFileIds) {
                this.completeFinishedFile(state, fileId);
            }
            if (state.unfinishedFileIds.size === 0) {
                await this.finalizeCollection(collection.id);
                continue;
            }
            for (const fileId of state.fileIds) {
                this.enqueueFile(fileId);
            }
        }
        this.wakeWaiters();
    }

    public async pauseCollection(collectionId: string) {
        const state = this.collections.get(collectionId);
        if (!state) {
            return;
        }
        for (const fileId of state.fileIds) {
            this.pauseFileState(fileId);
        }
        this.progressBatcher.deactivate(collectionId);
        await this.waitForCollectionIdle(collectionId);
        for (const fileId of state.fileIds) {
            this.completeFinishedFile(state, fileId);
        }
        this.stopCollectionTimer(collectionId);
        this.deactivateCollection(collectionId);
    }

    public async resumeCollection(collectionId: string) {
        const collection = this.repository.getCollection(collectionId);
        const state = collection
            ? (this.collections.get(collectionId) ?? this.restoreCollection(collection))
            : null;
        if (!state) {
            return;
        }
        state.failed = false;
        state.completing = false;
        for (const fileId of state.fileIds) {
            this.resumeFileState(fileId);
        }
        for (const fileId of state.fileIds) {
            this.completeFinishedFile(state, fileId);
        }
        if (state.unfinishedFileIds.size === 0) {
            await this.finalizeCollection(collectionId);
            return;
        }
        await this.schedule();
    }

    public async pauseFile(fileId: string) {
        const state = this.files.get(fileId);
        if (!state) {
            return;
        }
        this.pauseFileState(fileId);
        if (!this.hasRunnableFile(state.collectionId)) {
            this.progressBatcher.deactivate(state.collectionId);
        }
        await this.waitForFileIdle(state);
        const collection = this.collections.get(state.collectionId);
        if (collection) {
            this.completeFinishedFile(collection, fileId);
        }
        if (!this.hasRunnableFile(state.collectionId)) {
            this.stopCollectionTimer(state.collectionId);
            this.deactivateCollection(state.collectionId);
        }
    }

    public async resumeFile(fileId: string) {
        const state = this.files.get(fileId);
        if (!state) {
            const file = this.repository.getFile(fileId);
            const collection = file ? this.repository.getCollection(file.collectionId) : null;
            if (!collection) {
                return;
            }
            this.restoreCollection(collection);
        }
        this.resumeFileState(fileId);
        await this.schedule();
    }

    public async removeCollection(collectionId: string) {
        await this.pauseCollection(collectionId);
        this.removeQueuedCollection(collectionId);
        const state = this.collections.get(collectionId);
        if (state) {
            for (const fileId of state.fileIds) {
                this.files.delete(fileId);
            }
        }
        this.collections.delete(collectionId);
    }

    public destroy() {
        this.progressBatcher.destroy();
        for (const file of this.files.values()) {
            file.controller.abort();
        }
        for (const collectionId of [...this.collectionTimerStartedAt.keys()]) {
            this.stopCollectionTimer(collectionId);
        }
        this.targetWorkers = 0;
        this.wakeWaiters();
    }

    private restoreCollection(collection: UploadCollectionRow) {
        const files = this.repository.listFiles(collection.id);
        const chunksByFile = new Map<string, ServerFileMapping[]>();
        for (const file of files) {
            if (file.status === "completed") {
                continue;
            }
            if (!file.remoteId) {
                this.repository.markCollectionStatus(
                    collection.id,
                    "error",
                    "업로드 복구에 필요한 파일 정보가 없습니다. 새 업로드를 만드세요.",
                );
                return null;
            }
            chunksByFile.set(file.id, this.buildFileChunks(collection, file));
        }
        this.repository.syncCollectionUploadedBytesFromCompletedChunks(collection.id);
        this.registerCollection(collection.id, chunksByFile);
        return this.collections.get(collection.id) ?? null;
    }

    private buildFileChunks(collection: UploadCollectionRow, file: UploadFileRow) {
        const fileId = Buffer.from(file.remoteId, "hex");
        if (fileId.length === 0) {
            throw new Error(`업로드 원격 파일 ID가 올바르지 않습니다: ${file.path}`);
        }
        if (file.size === 0) {
            return [
                {
                    fileId,
                    relativePath: file.path,
                    size: 0,
                    offset: 0,
                    sequence: 0,
                    length: 0,
                    fsPath: file.fsPath,
                    sourceMtimeMs: file.sourceMtimeMs,
                },
            ];
        }
        const chunks: ServerFileMapping[] = [];
        for (
            let offset = 0, sequence = 0;
            offset < file.size;
            offset += collection.segmentSize, sequence += 1
        ) {
            chunks.push({
                fileId,
                relativePath: file.path,
                size: file.size,
                offset,
                sequence,
                length: Math.min(collection.segmentSize, file.size - offset),
                fsPath: file.fsPath,
                sourceMtimeMs: file.sourceMtimeMs,
            });
        }
        return chunks;
    }

    private registerCollection(
        collectionId: string,
        chunksByFile: Map<string, ServerFileMapping[]>,
    ) {
        const existing = this.collections.get(collectionId);
        if (existing) {
            for (const fileId of existing.fileIds) {
                this.files.delete(fileId);
            }
        }
        const fileIds = new Set<string>();
        for (const [fileId, chunks] of chunksByFile) {
            fileIds.add(fileId);
            this.files.set(fileId, {
                collectionId,
                fileId,
                chunks,
                completed: new Set(this.repository.listCompletedChunkIndexes(fileId)),
                queued: new Set(),
                inFlightSequences: new Set(),
                inFlight: 0,
                generation: 0,
                paused: false,
                failed: false,
                completionPersisted: false,
                controller: new AbortController(),
            });
        }
        this.collections.set(collectionId, {
            fileIds,
            unfinishedFileIds: new Set(fileIds),
            activeFileIds: new Set(),
            inFlight: 0,
            failed: false,
            completing: false,
        });
    }

    private enqueueFile(fileId: string) {
        const state = this.files.get(fileId);
        const collection = state ? this.collections.get(state.collectionId) : null;
        if (
            !state ||
            !collection ||
            state.paused ||
            state.failed ||
            collection.failed ||
            collection.completing
        ) {
            return;
        }
        for (const chunk of state.chunks) {
            if (
                state.completed.has(chunk.sequence) ||
                state.queued.has(chunk.sequence) ||
                state.inFlightSequences.has(chunk.sequence)
            ) {
                continue;
            }
            state.queued.add(chunk.sequence);
            this.queue.push({
                ...chunk,
                collectionId: state.collectionId,
                localFileId: fileId,
                generation: state.generation,
            });
        }
        if (state.queued.size > 0 || state.inFlight > 0) {
            this.activeCollections.add(state.collectionId);
            this.startCollectionTracking(state.collectionId);
            this.progressBatcher.activate(state.collectionId);
        }
    }

    private resize(maxWorkers: number) {
        this.targetWorkers = maxWorkers;
        while (this.runningWorkers < this.targetWorkers) {
            this.runningWorkers += 1;
            void this.workerLoop(this.runningWorkers);
        }
    }

    private async workerLoop(workerId: number) {
        try {
            while (workerId <= this.targetWorkers) {
                const chunk = this.queue.shift();
                if (!chunk) {
                    await this.waitForWork();
                    continue;
                }
                await this.processChunk(chunk);
            }
        } finally {
            this.runningWorkers -= 1;
            if (this.runningWorkers < this.targetWorkers) {
                this.resize(this.targetWorkers);
            }
        }
    }

    private async processChunk(chunk: PendingChunk) {
        const file = this.files.get(chunk.localFileId);
        const collection = this.collections.get(chunk.collectionId);
        if (!file || !collection) {
            return;
        }
        file.queued.delete(chunk.sequence);
        if (!this.isCurrentChunk(file, collection, chunk)) {
            return;
        }
        file.inFlight += 1;
        collection.activeFileIds.add(chunk.localFileId);
        collection.inFlight += 1;
        file.inFlightSequences.add(chunk.sequence);
        try {
            const settings = await this.getSettings();
            const row: UploadChunkRow = {
                collectionId: chunk.collectionId,
                fileId: chunk.localFileId,
                chunkIndex: chunk.sequence,
                offset: chunk.offset,
                size: chunk.length,
                status: "uploading",
                uploadedBytes: 0,
                attempts: 0,
                updatedAt: new Date().toISOString(),
                error: null,
            };
            this.metrics.registerFile(chunk.collectionId, chunk.localFileId);
            let attempt = 1;
            let slowReconnects = 0;
            while (attempt <= settings.maxChunkRetries + 1) {
                if (!this.isCurrentChunk(file, collection, chunk)) {
                    this.repository.markChunkPending(chunk.localFileId, chunk.sequence);
                    return;
                }
                const persistedFile = this.repository.getFile(chunk.localFileId);
                const persistedCollection = this.repository.getCollection(chunk.collectionId);
                if (persistedFile?.status === "pending") {
                    this.repository.markFileStatus(chunk.localFileId, "uploading");
                }
                if (persistedCollection?.status === "queued") {
                    this.repository.markCollectionStatus(chunk.collectionId, "uploading");
                }
                this.markProgress(chunk.collectionId, chunk.localFileId);
                this.repository.markChunkUploading(row);
                const attemptController = new AbortController();
                const onAbort = () => attemptController.abort();
                file.controller.signal.addEventListener("abort", onAbort, { once: true });
                let stalled = false;
                let stallTimer = setTimeout(() => {
                    stalled = true;
                    attemptController.abort();
                }, STALL_TIMEOUT_MS);
                const resetStallTimer = () => {
                    clearTimeout(stallTimer);
                    stallTimer = setTimeout(() => {
                        stalled = true;
                        attemptController.abort();
                    }, STALL_TIMEOUT_MS);
                };
                try {
                    const bytes = await this.api.uploadSegment(
                        chunk,
                        persistedCollection?.uploadToken ?? "",
                        attemptController.signal,
                        (transferred) => {
                            this.metrics.setChunkTransferProgress(
                                chunk.localFileId,
                                chunk.sequence,
                                transferred,
                            );
                            this.markProgress(chunk.collectionId, chunk.localFileId);
                            resetStallTimer();
                        },
                    );
                    clearTimeout(stallTimer);
                    file.controller.signal.removeEventListener("abort", onAbort);
                    if (file.failed || collection.failed || file.generation !== chunk.generation) {
                        return;
                    }
                    this.repository.markChunkCompleted(row, bytes);
                    this.repository.addFileUploadedBytes(chunk.localFileId, bytes);
                    file.completed.add(chunk.sequence);
                    this.metrics.completeChunk(chunk.localFileId, chunk.sequence);
                    this.markProgress(chunk.collectionId, chunk.localFileId);
                    return;
                } catch (error) {
                    clearTimeout(stallTimer);
                    file.controller.signal.removeEventListener("abort", onAbort);
                    this.metrics.clearChunk(chunk.localFileId, chunk.sequence);
                    if (!this.isCurrentChunk(file, collection, chunk)) {
                        this.repository.markChunkPending(chunk.localFileId, chunk.sequence);
                        return;
                    }
                    if (error instanceof UploadSessionExpiredError) {
                        await this.failCollection(
                            chunk.collectionId,
                            "expired",
                            error.message,
                            chunk.localFileId,
                        );
                        return;
                    }
                    if (error instanceof UploadSourceChangedError) {
                        await this.failCollection(
                            chunk.collectionId,
                            "error",
                            error.message,
                            chunk.localFileId,
                        );
                        return;
                    }
                    if (stalled && slowReconnects < MAX_SLOW_RECONNECTS) {
                        slowReconnects += 1;
                        this.repository.markChunkPending(chunk.localFileId, chunk.sequence);
                        this.kd.logger.warn(
                            {
                                collectionId: chunk.collectionId,
                                fileId: chunk.localFileId,
                                chunkIndex: chunk.sequence,
                                slowReconnects,
                            },
                            "UploadScheduler:slowChunkReconnect",
                        );
                        continue;
                    }
                    const message = toErrorMessage(error);
                    if (isAbortError(error) || file.controller.signal.aborted) {
                        this.repository.markChunkPending(chunk.localFileId, chunk.sequence);
                        return;
                    }
                    if (attempt <= settings.maxChunkRetries) {
                        this.repository.markChunkPending(chunk.localFileId, chunk.sequence);
                        this.kd.logger.warn(
                            {
                                collectionId: chunk.collectionId,
                                fileId: chunk.localFileId,
                                chunkIndex: chunk.sequence,
                                attempt,
                                message,
                            },
                            "UploadScheduler:retryChunk",
                        );
                        await sleepWithAbort(chunkBackoffMs(attempt), file.controller.signal);
                        attempt += 1;
                        continue;
                    }
                    this.repository.markChunkError(row, message);
                    await this.failCollection(
                        chunk.collectionId,
                        "error",
                        message,
                        chunk.localFileId,
                    );
                    return;
                }
            }
        } finally {
            file.inFlightSequences.delete(chunk.sequence);
            file.inFlight -= 1;
            if (file.inFlight === 0) {
                collection.activeFileIds.delete(chunk.localFileId);
            }
            collection.inFlight -= 1;
            await this.afterChunkSettled(chunk.collectionId, chunk.localFileId);
        }
    }

    private async afterChunkSettled(collectionId: string, fileId: string) {
        const collection = this.collections.get(collectionId);
        if (!collection) {
            return;
        }
        if (collection.failed) {
            if (collection.inFlight === 0) {
                this.deactivateCollection(collectionId);
            }
            return;
        }
        if (!this.completeFinishedFile(collection, fileId)) {
            return;
        }
        if (collection.unfinishedFileIds.size > 0 || collection.inFlight > 0) {
            return;
        }
        await this.finalizeCollection(collectionId);
    }

    private completeFinishedFile(collection: CollectionWorkState, fileId: string) {
        const file = this.files.get(fileId);
        if (
            !file ||
            file.completionPersisted ||
            file.inFlight > 0 ||
            file.completed.size !== file.chunks.length
        ) {
            return false;
        }
        this.repository.completeFile(fileId);
        file.completionPersisted = true;
        collection.unfinishedFileIds.delete(fileId);
        this.markProgress(file.collectionId, fileId);
        return true;
    }

    private async finalizeCollection(collectionId: string) {
        const state = this.collections.get(collectionId);
        const collection = this.repository.getCollection(collectionId);
        if (!state || !collection || state.completing || state.failed) {
            return;
        }
        state.completing = true;
        try {
            await this.api.completeCollection(collection.uploadToken);
            this.repository.completeUpload(
                collectionId,
                KioUploadClient.buildShareLink(Buffer.from(collection.collectionUuid, "hex")),
            );
            await this.emitUpdate(collectionId);
            await this.kd.service.transfer.maybeShutdownAfterTransfer();
        } catch (error) {
            state.completing = false;
            const status = error instanceof UploadSessionExpiredError ? "expired" : "error";
            this.repository.markCollectionStatus(collectionId, status, toErrorMessage(error));
            await this.emitUpdate(collectionId);
        } finally {
            this.stopCollectionTimer(collectionId);
            this.deactivateCollection(collectionId);
            await this.kd.service.transfer.refreshPowerSaveBlock();
        }
    }

    private async failCollection(
        collectionId: string,
        status: "error" | "expired",
        message: string,
        failedFileId: string,
    ) {
        const collection = this.collections.get(collectionId);
        if (!collection || collection.failed) {
            return;
        }
        collection.failed = true;
        this.progressBatcher.deactivate(collectionId);
        this.removeQueuedCollection(collectionId);
        for (const fileId of collection.fileIds) {
            const file = this.files.get(fileId);
            if (!file || fileId === failedFileId) {
                continue;
            }
            file.failed = true;
            file.controller.abort();
            const persisted = this.repository.getFile(fileId);
            if (persisted?.status !== "completed") {
                this.repository.markFileStatus(fileId, "error", message);
            }
        }
        this.repository.markFileStatus(failedFileId, "error", message);
        this.repository.markCollectionStatus(collectionId, status, message);
        await this.emitUpdate(collectionId);
    }

    private isCurrentChunk(
        file: FileWorkState,
        collection: CollectionWorkState,
        chunk: PendingChunk,
    ) {
        return (
            !file.paused &&
            !file.failed &&
            !collection.failed &&
            !collection.completing &&
            file.generation === chunk.generation &&
            !file.controller.signal.aborted
        );
    }

    private markProgress(collectionId: string, fileId: string) {
        const collection = this.collections.get(collectionId);
        const file = this.files.get(fileId);
        if (!collection || collection.failed || collection.completing || !file || file.paused) {
            return;
        }
        this.progressBatcher.mark(collectionId, fileId);
    }

    private pauseFileState(fileId: string) {
        const file = this.files.get(fileId);
        if (!file) {
            return;
        }
        // Stop scheduling; let in-flight PUTs finish so more segments land on the server.
        file.paused = true;
        this.removeQueuedFile(fileId);
    }

    private resumeFileState(fileId: string) {
        const file = this.files.get(fileId);
        if (!file) {
            return;
        }
        if (this.repository.getFile(fileId)?.status === "completed") {
            return;
        }
        for (const chunkIndex of this.repository.listCompletedChunkIndexes(fileId)) {
            file.completed.add(chunkIndex);
        }
        file.queued.clear();
        this.metrics.clearFile(fileId);
        this.metrics.registerFile(file.collectionId, fileId);
        file.paused = false;
        file.failed = false;
        file.generation += 1;
        file.controller = new AbortController();
    }

    private removeQueuedCollection(collectionId: string) {
        this.removeFromQueue((chunk) => chunk.collectionId === collectionId);
    }

    private removeQueuedFile(fileId: string) {
        this.removeFromQueue((chunk) => chunk.localFileId === fileId);
    }

    private removeFromQueue(predicate: (chunk: PendingChunk) => boolean) {
        const retained = this.queue.filter((chunk) => !predicate(chunk));
        for (const chunk of this.queue) {
            if (predicate(chunk)) {
                this.files.get(chunk.localFileId)?.queued.delete(chunk.sequence);
            }
        }
        this.queue.length = 0;
        this.queue.push(...retained);
    }

    private hasRunnableFile(collectionId: string) {
        return [...(this.collections.get(collectionId)?.fileIds ?? [])].some((fileId) => {
            const file = this.files.get(fileId);
            return (
                file && !file.paused && !file.failed && file.completed.size !== file.chunks.length
            );
        });
    }

    private waitForFileIdle(file: FileWorkState) {
        return new Promise<void>((resolve) => {
            const timer = setInterval(() => {
                if (file.inFlight === 0) {
                    clearInterval(timer);
                    resolve();
                }
            }, 10);
        });
    }

    private async waitForCollectionIdle(collectionId: string) {
        await Promise.all(
            [...(this.collections.get(collectionId)?.fileIds ?? [])]
                .map((fileId) => this.files.get(fileId))
                .filter((file): file is FileWorkState => Boolean(file))
                .map((file) => this.waitForFileIdle(file)),
        );
    }

    private startCollectionTracking(collectionId: string) {
        if (!this.collectionTimerStartedAt.has(collectionId)) {
            this.collectionTimerStartedAt.set(collectionId, performance.now());
        }
    }

    private stopCollectionTimer(collectionId: string) {
        const startedAt = this.collectionTimerStartedAt.get(collectionId);
        if (startedAt === undefined) {
            return;
        }
        this.collectionTimerStartedAt.delete(collectionId);
        this.repository.addCollectionElapsedMs(collectionId, performance.now() - startedAt);
    }

    private deactivateCollection(collectionId: string) {
        this.activeCollections.delete(collectionId);
        this.metrics.clearCollection(collectionId);
        this.progressBatcher.deactivate(collectionId);
    }

    private wakeWaiters() {
        while (this.waiters.length > 0) {
            this.waiters.shift()?.();
        }
    }

    private waitForWork() {
        return new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    private async getSettings(): Promise<SchedulerSettings> {
        return {
            maxWorkers: Math.min(
                MAX_UPLOAD_IN_FLIGHT_SEGMENTS,
                await this.kd.setting.get("transfer.segmentPoolSize"),
            ),
            maxChunkRetries: await this.kd.setting.get("transfer.uploadMaxChunkRetries"),
        };
    }
}
