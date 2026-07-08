import path from "node:path";
import { performance } from "node:perf_hooks";

import {
    CHUNK_RETRY_DEFAULT,
    CHUNK_RETRY_MAX,
    CHUNK_RETRY_MIN,
    SEGMENT_POOL_SIZE_DEFAULT,
    SEGMENT_POOL_SIZE_MAX,
    SEGMENT_POOL_SIZE_MIN,
    STREAM_WRITE_BATCH_BYTES_DEFAULT,
    STREAM_WRITE_BATCH_BYTES_OPTIONS,
} from "@shared/settings";
import { normalizePath, toErrorMessage } from "@shared/utils";
import fse from "fs-extra";

import type { KioskDownloader } from "../..";
import type { KioApiClient } from "./kio-api-client";
import type { DownloadTransferMetrics } from "./metrics";
import type { DownloadRepository } from "./repository";
import type {
    DownloadChunkRow,
    DownloadCollectionRow,
    DownloadFileRow,
    SchedulerSettings,
} from "./types";

import { PartFileWriter } from "./part-file";
import { GlobalSegmentPool } from "./segment-pool";

function clampChunkRetries(value: number) {
    return Math.min(
        CHUNK_RETRY_MAX,
        Math.max(CHUNK_RETRY_MIN, ensurePositiveInteger(value, CHUNK_RETRY_DEFAULT)),
    );
}

function clampSegmentPoolSize(value: number) {
    return Math.min(
        SEGMENT_POOL_SIZE_MAX,
        Math.max(SEGMENT_POOL_SIZE_MIN, ensurePositiveInteger(value, SEGMENT_POOL_SIZE_DEFAULT)),
    );
}

function clampStreamWriteBatchBytes(value: number) {
    if (
        STREAM_WRITE_BATCH_BYTES_OPTIONS.includes(
            value as (typeof STREAM_WRITE_BATCH_BYTES_OPTIONS)[number],
        )
    ) {
        return value;
    }
    return STREAM_WRITE_BATCH_BYTES_DEFAULT;
}

function ensurePositiveInteger(value: number, fallback: number) {
    if (!Number.isFinite(value) || value < 1) {
        return fallback;
    }
    return Math.max(1, Math.floor(value));
}

const PROGRESS_EMIT_INTERVAL_MS = 500;

export class DownloadScheduler {
    private readonly activeCollections = new Set<string>();
    private readonly activeFilesByCollection = new Map<string, Set<string>>();
    private readonly fileControllers = new Map<string, AbortController>();
    private readonly manualCollections = new Set<string>();
    private readonly manualFiles = new Set<string>();
    private readonly sessionCache = new Map<string, { cat: string; fetchedAt: number }>();
    private progressPollTimer: ReturnType<typeof setInterval> | null = null;
    private readonly segmentPool: GlobalSegmentPool;
    private readonly fileStartOrder: string[] = [];
    private readonly collectionStartOrder: string[] = [];
    private readonly fileStartedAt = new Map<string, number>();
    private readonly collectionStartedAt = new Map<string, number>();
    private readonly collectionTimerStartedAt = new Map<string, number>();
    private isPumping = false;
    private pumpAgain = false;

    public constructor(
        private readonly kd: KioskDownloader,
        private readonly api: KioApiClient,
        private readonly repository: DownloadRepository,
        private readonly metrics: DownloadTransferMetrics,
        private readonly emitUpdate: (collectionId?: string) => Promise<void>,
        private readonly emitProgressUpdate: (collectionId: string) => Promise<void>,
    ) {
        this.segmentPool = new GlobalSegmentPool({
            kd: this.kd,
            api: this.api,
            repository: this.repository,
            metrics: this.metrics,
            onChunkSettled: () => {
                void this.schedule();
            },
        });
    }

    public hasActiveTransfers() {
        return this.fileControllers.size > 0;
    }

    public getCollectionElapsedMs(collectionId: string) {
        const persistedMs = this.repository.getCollectionElapsedMs(collectionId);
        const timerStartedAt = this.collectionTimerStartedAt.get(collectionId);
        if (timerStartedAt === undefined) {
            return persistedMs;
        }

        return persistedMs + Math.max(0, performance.now() - timerStartedAt);
    }

    public async schedule() {
        if (this.isPumping) {
            this.pumpAgain = true;
            return;
        }

        this.isPumping = true;
        try {
            do {
                this.pumpAgain = false;
                await this.pumpOnce();
            } while (this.pumpAgain);
        } finally {
            this.isPumping = false;
        }
    }

    public pauseCollection(collectionId: string) {
        this.manualCollections.delete(collectionId);
        for (const fileId of this.activeFilesByCollection.get(collectionId) ?? []) {
            this.segmentPool.cancelSession(fileId);
            this.fileControllers.get(fileId)?.abort();
            this.metrics.clearFile(fileId);
        }
        this.deactivateCollectionTransfer(collectionId);
        this.sessionCache.delete(collectionId);
        this.clearCollectionStartTracking(collectionId);
        this.stopCollectionTimer(collectionId);
    }

    public resumeCollection(collectionId: string) {
        this.manualCollections.add(collectionId);
        void this.schedule();
    }

    public pauseFile(fileId: string) {
        this.manualFiles.delete(fileId);
        this.segmentPool.cancelSession(fileId);
        this.fileControllers.get(fileId)?.abort();
        this.metrics.clearFile(fileId);
    }

    public resumeFile(fileId: string) {
        this.manualFiles.add(fileId);
        void this.schedule();
    }

    public removeCollection(collectionId: string) {
        for (const fileId of this.activeFilesByCollection.get(collectionId) ?? []) {
            this.segmentPool.cancelSession(fileId);
            this.fileControllers.get(fileId)?.abort();
            this.metrics.clearFile(fileId);
            this.clearFileStartTracking(fileId);
        }
        this.deactivateCollectionTransfer(collectionId);
        this.manualCollections.delete(collectionId);
        this.sessionCache.delete(collectionId);
        this.clearCollectionStartTracking(collectionId);
        this.stopCollectionTimer(collectionId);
    }

    public destroy() {
        this.stopProgressPollTimer();
        for (const collectionId of [...this.collectionTimerStartedAt.keys()]) {
            this.stopCollectionTimer(collectionId);
        }
    }

    public async cleanupPartFiles(collection: DownloadCollectionRow, files: DownloadFileRow[]) {
        await Promise.all(
            files.map(async (file) => {
                const partPath = this.getPartPath(collection, file);
                await fse.remove(partPath).catch(() => undefined);
                await PartFileWriter.removeSidecar(partPath);
            }),
        );
        await fse
            .remove(path.join(collection.savePath, ".kiosk-part", collection.id))
            .catch(() => undefined);
    }

    private async pumpOnce() {
        const settings = await this.getSettings();
        const segmentPoolSize = settings.segmentPoolSize;
        this.segmentPool.resize(segmentPoolSize);
        const collections = this.repository.listRunnableCollections();

        for (const collection of collections) {
            const hasPending = this.repository
                .listPendingFiles(collection.id)
                .some((file) => !this.fileControllers.has(file.id));
            const isNewCollection = hasPending && !this.activeCollections.has(collection.id);

            if (isNewCollection) {
                while (this.activeCollections.size >= segmentPoolSize) {
                    if (!this.evictOldestActiveCollection()) {
                        break;
                    }
                }
            }

            let startedAny = false;
            while (true) {
                const nextFile = this.pickNextFile(collection.id);
                if (!nextFile) {
                    break;
                }

                if (!this.canStartFile(collection.id, segmentPoolSize)) {
                    break;
                }

                while (this.fileControllers.size >= segmentPoolSize) {
                    if (!this.evictOldestActiveFile()) {
                        break;
                    }
                }

                if (this.fileControllers.size >= segmentPoolSize) {
                    break;
                }

                this.startFile(collection, nextFile, settings);
                startedAny = true;
            }

            if (startedAny && collection.status !== "downloading") {
                this.repository.markCollectionStatus(collection.id, "downloading");
                await this.emitUpdate(collection.id);
            }
        }

        await this.kd.service.transfer.refreshPowerSaveBlock();
    }

    private async getSettings(): Promise<SchedulerSettings> {
        return {
            segmentPoolSize: clampSegmentPoolSize(
                await this.kd.setting.transfer.getSegmentPoolSize(),
            ),
            maxChunkRetries: clampChunkRetries(await this.kd.setting.transfer.getMaxChunkRetries()),
            streamWriteBatchBytes: clampStreamWriteBatchBytes(
                await this.kd.setting.transfer.getStreamWriteBatchBytes(),
            ),
        };
    }

    private pickNextFile(collectionId: string) {
        const pending = this.repository
            .listPendingFiles(collectionId)
            .filter((file) => !this.fileControllers.has(file.id));
        return pending.find((file) => this.manualFiles.has(file.id)) ?? pending[0] ?? null;
    }

    private getFilePriority(collectionId: string, fileId: string) {
        if (this.manualFiles.has(fileId)) {
            return 0;
        }
        if (this.manualCollections.has(collectionId)) {
            return 1;
        }
        return 2;
    }

    private canStartFile(collectionId: string, segmentPoolSize: number) {
        const activeFileIds = [...(this.activeFilesByCollection.get(collectionId) ?? [])].filter(
            (fileId) => this.fileControllers.has(fileId),
        );

        if (activeFileIds.length === 0) {
            return true;
        }

        if (this.segmentPool.getTotalInFlight() >= segmentPoolSize) {
            return false;
        }

        let outstandingChunks = 0;
        for (const fileId of activeFileIds) {
            const outstanding = this.segmentPool.getOutstandingChunks(fileId);
            if (outstanding === null) {
                return false;
            }
            outstandingChunks += outstanding;
        }

        // If active files have fewer outstanding chunks than the pool size, they cannot
        // occupy every worker; let the next file fill the idle segment slots.
        return outstandingChunks < segmentPoolSize;
    }

    private evictOldestActiveFile() {
        const oldestFileId = this.fileStartOrder.find((fileId) => this.fileControllers.has(fileId));
        if (!oldestFileId) {
            return false;
        }

        this.yieldFileToPending(oldestFileId);
        return true;
    }

    private evictOldestActiveCollection() {
        const oldestCollectionId = this.collectionStartOrder.find((collectionId) =>
            this.activeCollections.has(collectionId),
        );
        if (!oldestCollectionId) {
            return false;
        }

        for (const fileId of [...(this.activeFilesByCollection.get(oldestCollectionId) ?? [])]) {
            this.yieldFileToPending(fileId);
        }
        this.deactivateCollectionTransfer(oldestCollectionId);
        this.stopCollectionTimer(oldestCollectionId);
        this.repository.markCollectionStatus(oldestCollectionId, "queued");
        return true;
    }

    private yieldFileToPending(fileId: string) {
        this.pauseFile(fileId);
        this.repository.resetRunningChunksForFile(fileId);
        this.repository.markFileStatus(fileId, "pending");
    }

    private clearFileStartTracking(fileId: string) {
        this.fileStartedAt.delete(fileId);
        const index = this.fileStartOrder.indexOf(fileId);
        if (index >= 0) {
            this.fileStartOrder.splice(index, 1);
        }
    }

    private clearCollectionStartTracking(collectionId: string) {
        this.collectionStartedAt.delete(collectionId);
        const index = this.collectionStartOrder.indexOf(collectionId);
        if (index >= 0) {
            this.collectionStartOrder.splice(index, 1);
        }
    }

    private startCollectionTimer(collectionId: string) {
        if (this.collectionTimerStartedAt.has(collectionId)) {
            return;
        }

        this.collectionTimerStartedAt.set(collectionId, performance.now());
    }

    private stopCollectionTimer(collectionId: string) {
        const timerStartedAt = this.collectionTimerStartedAt.get(collectionId);
        if (timerStartedAt === undefined) {
            return;
        }

        this.collectionTimerStartedAt.delete(collectionId);
        this.repository.addCollectionElapsedMs(collectionId, performance.now() - timerStartedAt);
    }

    private startFile(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        settings: SchedulerSettings,
    ) {
        const startedAt = Date.now();
        this.fileStartedAt.set(file.id, startedAt);
        this.fileStartOrder.push(file.id);

        if (!this.collectionStartedAt.has(collection.id)) {
            this.collectionStartedAt.set(collection.id, startedAt);
            this.collectionStartOrder.push(collection.id);
            this.startCollectionTimer(collection.id);
        }

        const controller = new AbortController();
        this.fileControllers.set(file.id, controller);
        this.activeCollections.add(collection.id);
        this.ensureProgressPollTimer();

        const activeFiles = this.activeFilesByCollection.get(collection.id) ?? new Set<string>();
        activeFiles.add(file.id);
        this.activeFilesByCollection.set(collection.id, activeFiles);

        void this.runFile(collection.id, file.id, settings, controller).finally(() => {
            this.fileControllers.delete(file.id);
            this.clearFileStartTracking(file.id);
            const files = this.activeFilesByCollection.get(collection.id);
            files?.delete(file.id);
            if (!files || files.size === 0) {
                this.activeFilesByCollection.delete(collection.id);
                this.activeCollections.delete(collection.id);
                this.metrics.clearCollection(collection.id);
                this.clearCollectionStartTracking(collection.id);
                this.stopCollectionTimer(collection.id);
                this.stopProgressPollTimerIfIdle();
            }
            void this.afterFileSettled(collection.id, file.id);
        });
    }

    private async afterFileSettled(collectionId: string, fileId: string) {
        const file = this.repository.getFile(fileId);
        if (
            !file ||
            file.status === "completed" ||
            file.status === "paused" ||
            file.status === "error"
        ) {
            this.manualFiles.delete(fileId);
        }

        const collection = this.repository.getCollection(collectionId);
        if (
            !collection ||
            collection.status === "completed" ||
            collection.status === "paused" ||
            collection.status === "error" ||
            collection.status === "expired"
        ) {
            this.manualCollections.delete(collectionId);
            this.sessionCache.delete(collectionId);
        }

        this.repository.recomputeCollectionStatus(collectionId);
        const updatedCollection = this.repository.getCollection(collectionId);
        if (
            updatedCollection &&
            (updatedCollection.status === "completed" ||
                updatedCollection.status === "error" ||
                updatedCollection.status === "expired" ||
                updatedCollection.status === "paused")
        ) {
            this.stopCollectionTimer(collectionId);
        }
        await this.emitUpdate(collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
        void this.schedule();
    }

    private async runFile(
        collectionId: string,
        fileId: string,
        settings: SchedulerSettings,
        controller: AbortController,
    ) {
        const signal = controller.signal;
        let collection = this.repository.getCollection(collectionId);
        let file = this.repository.getFile(fileId);
        if (!collection || !file) {
            return;
        }

        if (this.repository.ensureCollectionNotExpired(collectionId)) {
            await this.emitUpdate(collectionId);
            return;
        }

        let partWriter: PartFileWriter | null = null;

        try {
            this.repository.resetRunningChunksForFile(fileId);
            this.repository.markFileStatus(fileId, "downloading");
            this.repository.markCollectionStatus(collectionId, "downloading");
            await this.emitUpdate(collectionId);

            const chunks = this.repository.listChunks(file.id);
            await this.validateCompletedChunks(collection, file, chunks);
            this.repository.syncFileDownloadedBytes(fileId);

            file = this.repository.getFile(fileId);
            collection = this.repository.getCollection(collectionId);
            if (!collection || !file) {
                return;
            }

            const refreshedChunks = this.repository.listChunks(file.id);
            if (file.size === 0 || this.areChunksComplete(refreshedChunks)) {
                await this.finalizeFile(collection, file);
                return;
            }

            const cat = await this.getCollectionToken(collection);
            const segments = await this.api.getSegments(file.remoteId, cat);
            const pendingChunks = refreshedChunks.filter(
                (chunk) => chunk.status === "pending" || chunk.status === "error",
            );
            partWriter = new PartFileWriter(this.getPartPath(collection, file));
            await partWriter.open(file.size, refreshedChunks.length);

            const outcome = await this.segmentPool.register({
                collection,
                file,
                segments,
                partWriter,
                controller,
                maxChunkRetries: settings.maxChunkRetries,
                streamWriteBatchBytes: settings.streamWriteBatchBytes,
                priority: this.getFilePriority(collectionId, fileId),
                chunks: pendingChunks,
                startedAt: this.fileStartedAt.get(fileId) ?? Date.now(),
                collectionStartedAt: this.collectionStartedAt.get(collectionId) ?? Date.now(),
            });

            if (outcome === "paused") {
                if (!this.repository.hasErroredChunk(fileId)) {
                    const currentFile = this.repository.getFile(fileId);
                    if (currentFile?.status === "downloading") {
                        this.repository.markFileStatus(fileId, "pending");
                    }
                }
                return;
            }

            if (outcome === "failed") {
                return;
            }

            if (this.areChunksComplete(this.repository.listChunks(file.id))) {
                await this.finalizeFile(collection, file);
            }
        } catch (error) {
            this.repository.resetRunningChunksForFile(fileId);
            const currentFile = this.repository.getFile(fileId);

            if ((error instanceof DOMException && error.name === "AbortError") || signal.aborted) {
                if (!this.repository.hasErroredChunk(fileId)) {
                    if (currentFile?.status === "downloading") {
                        this.repository.markFileStatus(fileId, "pending");
                    }
                }
                return;
            }

            const message = toErrorMessage(error);
            if (currentFile) {
                this.repository.markFileStatus(fileId, "error", message);
            }
            this.kd.logger.error(error, "DownloadService:runFile");
        } finally {
            await partWriter?.close();
            this.metrics.clearFile(fileId);
        }
    }

    private deactivateCollectionTransfer(collectionId: string) {
        this.activeCollections.delete(collectionId);
        this.activeFilesByCollection.delete(collectionId);
        this.metrics.clearCollection(collectionId);
        this.stopProgressPollTimerIfIdle();
    }

    private stopProgressPollTimerIfIdle() {
        if (this.activeCollections.size === 0) {
            this.stopProgressPollTimer();
        }
    }

    private ensureProgressPollTimer() {
        if (this.progressPollTimer) {
            return;
        }

        this.progressPollTimer = setInterval(
            () => this.pollProgressUpdates(),
            PROGRESS_EMIT_INTERVAL_MS,
        );
    }

    private stopProgressPollTimer() {
        if (!this.progressPollTimer) {
            return;
        }

        clearInterval(this.progressPollTimer);
        this.progressPollTimer = null;
    }

    private pollProgressUpdates() {
        try {
            if (this.activeCollections.size === 0) {
                this.stopProgressPollTimer();
                return;
            }

            for (const collectionId of this.activeCollections) {
                void this.emitProgressUpdate(collectionId).catch((error) => {
                    this.kd.logger.error(error, "DownloadScheduler:pollProgressUpdates");
                });
            }
        } catch (error) {
            this.kd.logger.error(error, "DownloadScheduler:pollProgressUpdates");
        }
    }

    private async getCollectionToken(collection: DownloadCollectionRow) {
        const cached = this.sessionCache.get(collection.id);
        if (cached) {
            return cached.cat;
        }

        const refreshed = await this.api.refreshCollectionToken(collection);
        this.repository.updateCollectionFreshMeta(collection.id, {
            expires: refreshed.expires,
        });
        this.sessionCache.set(collection.id, { cat: refreshed.cat, fetchedAt: Date.now() });
        return refreshed.cat;
    }

    private async validateCompletedChunks(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        chunks: DownloadChunkRow[],
    ) {
        const partPath = this.getPartPath(collection, file);
        const completedChunks = chunks.filter((chunk) => chunk.status === "completed");
        if (completedChunks.length === 0) {
            return;
        }

        for (const chunk of completedChunks) {
            const isValid = await PartFileWriter.isChunkValid(partPath, chunk);
            if (!isValid) {
                this.repository.markChunkPending(chunk.fileId, chunk.chunkIndex);
            }
        }
    }

    private areChunksComplete(chunks: DownloadChunkRow[]) {
        return chunks.every((chunk) => chunk.status === "completed");
    }

    private async finalizeFile(collection: DownloadCollectionRow, file: DownloadFileRow) {
        const partPath = this.getPartPath(collection, file);
        const finalPath = this.getFinalPath(collection, file);

        await fse.ensureDir(path.dirname(finalPath));

        if (file.size === 0) {
            await fse.outputFile(finalPath, "");
        } else {
            const stat = await fse.stat(partPath);
            if (stat.size < file.size) {
                throw new Error(
                    `Part file is incomplete: expected ${file.size}B, got ${stat.size}B.`,
                );
            }
            await fse.move(partPath, finalPath, { overwrite: true });
        }

        await PartFileWriter.removeSidecar(partPath);
        this.repository.completeFile(file.id);
        await this.emitUpdate(collection.id);
    }

    private getPartPath(collection: DownloadCollectionRow, file: DownloadFileRow) {
        return `${this.getFinalPath(collection, file)}.part`;
    }

    private getFinalPath(collection: DownloadCollectionRow, file: DownloadFileRow) {
        return path.join(collection.savePath, this.getSafeRelativePath(file.path));
    }

    private getSafeRelativePath(input: string) {
        return normalizePath(input)
            .split("/")
            .filter(Boolean)
            .map((part) => this.kd.lib.fs.sanitizeWindowsFilename(part, "_"))
            .join(path.sep);
    }
}
