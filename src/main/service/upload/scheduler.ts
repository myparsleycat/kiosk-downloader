import { performance } from "node:perf_hooks";

import { CHUNK_RETRY_DEFAULT, CHUNK_RETRY_MAX, CHUNK_RETRY_MIN } from "@shared/settings";
import { toErrorMessage } from "@shared/utils";

import type { KioskDownloader } from "../..";
import type { UploadTransferMetrics } from "./metrics";
import type { UploadRepository } from "./repository";
import type { SchedulerSettings, UploadChunkRow } from "./types";

import { KioUploadClient } from "./kio-upload-client";

const MAX_UPLOAD_THREADS = 16;
const PROGRESS_EMIT_INTERVAL_MS = 500;

function clampChunkRetries(value: number) {
    return Math.min(
        CHUNK_RETRY_MAX,
        Math.max(CHUNK_RETRY_MIN, ensurePositiveInteger(value, CHUNK_RETRY_DEFAULT)),
    );
}

function ensurePositiveInteger(value: number, fallback: number) {
    if (!Number.isFinite(value) || value < 1) {
        return fallback;
    }
    return Math.max(1, Math.floor(value));
}

function chunkBackoffMs(attempt: number) {
    return 1000 * 2 ** (attempt - 1);
}

function sleepWithAbort(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
        }

        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
}

type PendingChunk = {
    collectionId: string;
    fileId: string;
    chunkIndex: number;
    offset: number;
    size: number;
    serverFileId: Buffer;
    fsPath: string;
    uploadToken: string;
};

type CollectionWorkState = {
    chunks: PendingChunk[];
    nextIndex: number;
    remaining: number;
    inFlight: number;
    failed: boolean;
    completing: boolean;
};

export class UploadScheduler {
    // Global segment queue across all active upload collections, drained by a
    // bounded worker pool.
    private readonly queue: PendingChunk[] = [];
    private readonly states = new Map<string, CollectionWorkState>();
    private readonly collectionControllers = new Map<string, AbortController>();
    private readonly waiters: Array<() => void> = [];
    private readonly activeCollections = new Set<string>();
    private readonly collectionTimerStartedAt = new Map<string, number>();
    private readonly progressUpdatesInFlight = new Set<string>();
    private targetWorkers = 0;
    private runningWorkers = 0;
    private progressPollTimer: ReturnType<typeof setInterval> | null = null;

    public constructor(
        private readonly kd: KioskDownloader,
        private readonly api: KioUploadClient,
        private readonly repository: UploadRepository,
        private readonly metrics: UploadTransferMetrics,
        private readonly emitUpdate: (collectionId?: string) => Promise<void>,
        private readonly emitProgressUpdate: (collectionId: string) => Promise<void>,
    ) {}

    public hasActiveTransfers() {
        return this.activeCollections.size > 0;
    }

    public getCollectionElapsedMs(collectionId: string) {
        const persistedMs = this.repository.getCollectionElapsedMs(collectionId);
        const timerStartedAt = this.collectionTimerStartedAt.get(collectionId);
        if (timerStartedAt === undefined) {
            return persistedMs;
        }
        return persistedMs + Math.max(0, performance.now() - timerStartedAt);
    }

    public registerWorkItems(
        collectionId: string,
        fileRows: { id: string; remoteId: string }[],
        workItems: WorkItem[],
        uploadToken: string,
    ) {
        const fileByRemoteHex = new Map(fileRows.map((file) => [file.remoteId, file.id]));

        const chunks: PendingChunk[] = [];
        for (const item of workItems) {
            const fileId = fileByRemoteHex.get(item.fileId.toString("hex"));
            if (!fileId) {
                continue;
            }
            chunks.push({
                collectionId,
                fileId,
                chunkIndex: item.sequence,
                offset: item.offset,
                size: item.length,
                serverFileId: item.fileId,
                fsPath: item.fsPath,
                uploadToken,
            });
        }

        this.states.set(collectionId, {
            chunks,
            nextIndex: 0,
            remaining: chunks.length,
            inFlight: 0,
            failed: false,
            completing: false,
        });
        this.collectionControllers.set(collectionId, new AbortController());
    }

    public async schedule() {
        const maxWorkers = (await this.getSettings()).maxWorkers;
        this.resize(maxWorkers);

        for (const collection of this.repository.listRunnableCollections()) {
            const state = this.states.get(collection.id);
            if (!state || state.failed || state.completing) {
                continue;
            }

            while (state.nextIndex < state.chunks.length) {
                const chunk = state.chunks[state.nextIndex];
                state.nextIndex += 1;
                state.inFlight += 1;
                this.queue.push(chunk);
                this.activeCollections.add(collection.id);
                this.ensureProgressPollTimer();
                this.startCollectionTracking(collection.id);
            }
        }

        this.wakeWaiters();
    }

    public pauseCollection(collectionId: string) {
        this.abortCollection(collectionId);
        const state = this.states.get(collectionId);
        if (state) {
            this.removeCollectionFromQueue(collectionId);
        }
        this.deactivateCollection(collectionId);
    }

    public resumeCollection(collectionId: string) {
        const state = this.states.get(collectionId);
        if (!state) {
            return;
        }
        // Reset nextIndex so un-started and aborted segments re-enter the queue.
        state.nextIndex = 0;
        state.inFlight = 0;
        state.failed = false;
        this.collectionControllers.set(collectionId, new AbortController());
        void this.schedule();
    }

    public pauseFile(fileId: string) {
        // Abort the collection owning this file (upload scheduling is segment-
        // granularity, not per-file). The service layer translates file pause
        // into a collection-level pause for simplicity.
        const collectionId = this.findCollectionOfFile(fileId);
        if (collectionId) {
            this.pauseCollection(collectionId);
        }
    }

    public resumeFile(fileId: string) {
        const collectionId = this.findCollectionOfFile(fileId);
        if (collectionId) {
            this.resumeCollection(collectionId);
        }
    }

    public removeCollection(collectionId: string) {
        this.abortCollection(collectionId);
        this.removeCollectionFromQueue(collectionId);
        this.states.delete(collectionId);
        this.collectionControllers.delete(collectionId);
        this.deactivateCollection(collectionId);
    }

    public destroy() {
        this.stopProgressPollTimer();
        for (const collectionId of [...this.collectionTimerStartedAt.keys()]) {
            this.stopCollectionTimer(collectionId);
        }
        for (const controller of this.collectionControllers.values()) {
            controller.abort();
        }
        this.targetWorkers = 0;
        this.wakeWaiters();
    }

    private resize(maxWorkers: number) {
        this.targetWorkers = Math.max(1, Math.floor(maxWorkers));
        while (this.runningWorkers < this.targetWorkers) {
            this.runningWorkers += 1;
            void this.workerLoop(this.runningWorkers);
        }
        this.wakeWaiters();
    }

    private async workerLoop(workerId: number) {
        try {
            while (true) {
                if (workerId > this.targetWorkers) {
                    return;
                }

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
        const state = this.states.get(chunk.collectionId);
        const controller = this.collectionControllers.get(chunk.collectionId);
        if (!state || !controller) {
            return;
        }

        const settings = await this.getSettings();
        const signal = controller.signal;
        this.metrics.registerFile(chunk.collectionId, chunk.fileId);
        const chunkRow: UploadChunkRow = {
            collectionId: chunk.collectionId,
            fileId: chunk.fileId,
            chunkIndex: chunk.chunkIndex,
            offset: chunk.offset,
            size: chunk.size,
            status: "uploading",
            uploadedBytes: 0,
            attempts: 0,
            updatedAt: new Date().toISOString(),
            error: null,
        };

        const maxAttempts = settings.maxChunkRetries + 1;
        let attempt = 1;

        while (attempt <= maxAttempts) {
            if (state.failed || signal.aborted) {
                this.repository.markChunkPending(chunk.fileId, chunk.chunkIndex);
                this.releaseChunk(chunk.collectionId);
                return;
            }

            let statusChanged = false;
            const file = this.repository.getFile(chunk.fileId);
            if (file?.status === "pending") {
                this.repository.markFileStatus(chunk.fileId, "uploading");
                statusChanged = true;
            }

            const collection = this.repository.getCollection(chunk.collectionId);
            if (collection?.status === "queued") {
                this.repository.markCollectionStatus(chunk.collectionId, "uploading");
                statusChanged = true;
            }
            if (statusChanged) {
                await this.emitUpdate(chunk.collectionId);
            }

            this.repository.markChunkUploading(chunkRow);

            try {
                const bytes = await this.api.uploadSegment(
                    {
                        fileId: chunk.serverFileId,
                        size: 0,
                        offset: chunk.offset,
                        sequence: chunk.chunkIndex,
                        length: chunk.size,
                        fsPath: chunk.fsPath,
                    },
                    chunk.uploadToken,
                    signal,
                    (transferredBytes) => {
                        if (!signal.aborted) {
                            this.metrics.setChunkTransferProgress(
                                chunk.fileId,
                                chunk.chunkIndex,
                                transferredBytes,
                            );
                        }
                    },
                );

                this.repository.markChunkCompleted(chunkRow, bytes);
                this.repository.addFileUploadedBytes(chunk.fileId, bytes);
                this.metrics.completeChunk(chunk.fileId, chunk.chunkIndex);
                state.remaining -= 1;
                this.releaseChunk(chunk.collectionId);
                await this.afterChunkSettled(chunk.collectionId);
                return;
            } catch (error) {
                this.metrics.clearChunk(chunk.fileId, chunk.chunkIndex);

                if (isAbortError(error) || signal.aborted) {
                    this.repository.markChunkPending(chunk.fileId, chunk.chunkIndex);
                    this.releaseChunk(chunk.collectionId);
                    return;
                }

                const message = toErrorMessage(error);
                if (attempt < maxAttempts) {
                    this.kd.logger.warn(
                        {
                            channel: "segment-upload",
                            collectionId: chunk.collectionId,
                            fileId: chunk.fileId,
                            chunkIndex: chunk.chunkIndex,
                            offset: chunk.offset,
                            size: chunk.size,
                            attempt,
                            maxRetries: settings.maxChunkRetries,
                            message,
                        },
                        "UploadService:uploadSegment",
                    );
                    this.repository.markChunkPending(chunk.fileId, chunk.chunkIndex);
                    try {
                        await sleepWithAbort(chunkBackoffMs(attempt), signal);
                    } catch (abortError) {
                        if (isAbortError(abortError) || signal.aborted) {
                            this.releaseChunk(chunk.collectionId);
                            return;
                        }
                        throw abortError;
                    }
                    attempt += 1;
                    continue;
                }

                this.kd.logger.error(
                    {
                        channel: "segment-upload",
                        collectionId: chunk.collectionId,
                        fileId: chunk.fileId,
                        chunkIndex: chunk.chunkIndex,
                        offset: chunk.offset,
                        size: chunk.size,
                        attempt,
                        maxRetries: settings.maxChunkRetries,
                        message,
                        rollback: "chunk marked error; collection will be marked error",
                    },
                    "UploadService:uploadSegment",
                );
                this.repository.markChunkError(chunkRow, message);
                this.repository.markFileStatus(chunk.fileId, "error", message);
                state.failed = true;
                this.releaseChunk(chunk.collectionId);
                await this.afterChunkSettled(chunk.collectionId);
                return;
            }
        }
    }

    private releaseChunk(collectionId: string) {
        const state = this.states.get(collectionId);
        if (state) {
            state.inFlight -= 1;
        }
    }

    private async afterChunkSettled(collectionId: string) {
        const state = this.states.get(collectionId);
        if (!state || state.inFlight > 0) {
            return;
        }

        if (state.failed) {
            this.repository.recomputeCollectionStatus(collectionId);
            await this.emitUpdate(collectionId);
            await this.kd.service.transfer.refreshPowerSaveBlock();
            return;
        }

        if (state.remaining > 0) {
            // All queued chunks drained but remaining > 0 means the queue was
            // refilled on resume; reschedule.
            void this.schedule();
            return;
        }

        await this.finalizeCollection(collectionId);
    }

    private async finalizeCollection(collectionId: string) {
        const state = this.states.get(collectionId);
        if (!state || state.completing) {
            return;
        }
        state.completing = true;

        const collection = this.repository.getCollection(collectionId);
        if (!collection) {
            return;
        }

        try {
            for (const file of this.repository.listFiles(collectionId)) {
                if (file.status !== "completed") {
                    this.repository.syncFileUploadedBytes(file.id);
                    this.repository.completeFile(file.id);
                }
            }

            await this.api.completeCollection(collection.uploadToken);

            const collectionUuid = Buffer.from(collection.collectionUuid, "hex");
            const shareLink = KioUploadClient.buildShareLink(collectionUuid);
            this.repository.completeCollection(collectionId, shareLink);
            this.stopCollectionTimer(collectionId);
            await this.emitUpdate(collectionId);
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "collection-complete",
                    stage: "complete",
                    collectionId,
                    uploadToken: collection.uploadToken.slice(0, 16) + "...",
                    message: toErrorMessage(error),
                    rollback: "segments uploaded but completion failed; manual retry needed",
                },
                "UploadService:finalizeCollection",
            );
            this.repository.markCollectionStatus(collectionId, "error", toErrorMessage(error));
            await this.emitUpdate(collectionId);
        } finally {
            this.deactivateCollection(collectionId);
            await this.kd.service.transfer.refreshPowerSaveBlock();
        }
    }

    private abortCollection(collectionId: string) {
        this.collectionControllers.get(collectionId)?.abort();
    }

    private removeCollectionFromQueue(collectionId: string) {
        const remaining = this.queue.filter((chunk) => chunk.collectionId !== collectionId);
        this.queue.length = 0;
        this.queue.push(...remaining);

        const state = this.states.get(collectionId);
        if (state) {
            // Re-queue aborted segments by rewinding nextIndex past un-started work.
            state.nextIndex = 0;
            state.inFlight = 0;
        }
    }

    private findCollectionOfFile(fileId: string): string | null {
        for (const [collectionId, state] of this.states) {
            if (state.chunks.some((chunk) => chunk.fileId === fileId)) {
                return collectionId;
            }
        }
        return null;
    }

    private startCollectionTracking(collectionId: string) {
        if (!this.collectionTimerStartedAt.has(collectionId)) {
            this.collectionTimerStartedAt.set(collectionId, performance.now());
        }
    }

    private stopCollectionTimer(collectionId: string) {
        const timerStartedAt = this.collectionTimerStartedAt.get(collectionId);
        if (timerStartedAt === undefined) {
            return;
        }
        this.collectionTimerStartedAt.delete(collectionId);
        this.repository.addCollectionElapsedMs(collectionId, performance.now() - timerStartedAt);
    }

    private deactivateCollection(collectionId: string) {
        this.activeCollections.delete(collectionId);
        this.metrics.clearCollection(collectionId);
        this.stopProgressPollTimerIfIdle();
    }

    private ensureProgressPollTimer() {
        if (this.progressPollTimer) {
            return;
        }
        this.progressPollTimer = setInterval(
            () => this.pollProgressUpdates(),
            PROGRESS_EMIT_INTERVAL_MS,
        );
        this.progressPollTimer.unref?.();
    }

    private stopProgressPollTimer() {
        if (!this.progressPollTimer) {
            return;
        }
        clearInterval(this.progressPollTimer);
        this.progressPollTimer = null;
    }

    private stopProgressPollTimerIfIdle() {
        if (this.activeCollections.size === 0) {
            this.stopProgressPollTimer();
        }
    }

    private pollProgressUpdates() {
        try {
            if (this.activeCollections.size === 0) {
                this.stopProgressPollTimer();
                return;
            }
            for (const collectionId of this.activeCollections) {
                void this.emitProgressUpdateOnce(collectionId).catch((error) => {
                    this.kd.logger.error(error, "UploadScheduler:pollProgressUpdates");
                });
            }
        } catch (error) {
            this.kd.logger.error(error, "UploadScheduler:pollProgressUpdates");
        }
    }

    private async emitProgressUpdateOnce(collectionId: string) {
        if (this.progressUpdatesInFlight.has(collectionId)) {
            return;
        }

        this.progressUpdatesInFlight.add(collectionId);
        try {
            await this.emitProgressUpdate(collectionId);
        } finally {
            this.progressUpdatesInFlight.delete(collectionId);
        }
    }

    private wakeWaiters() {
        while (this.waiters.length > 0) {
            this.waiters.shift()?.();
        }
    }

    private waitForWork() {
        return new Promise<void>((resolve) => {
            this.waiters.push(resolve);
        });
    }

    private async getSettings(): Promise<SchedulerSettings> {
        return {
            maxWorkers: MAX_UPLOAD_THREADS,
            maxChunkRetries: clampChunkRetries(await this.kd.setting.transfer.getMaxChunkRetries()),
        };
    }
}

type WorkItem = {
    fileId: Buffer;
    size: number;
    offset: number;
    sequence: number;
    length: number;
    fsPath: string;
};
