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
    INFLATE_BUFFER_BYTES_DEFAULT,
    INFLATE_BUFFER_BYTES_OPTIONS,
} from "@shared/settings";
import type { FileDownloadStatus } from "@shared/types";
import { toErrorMessage } from "@shared/utils";
import fse from "fs-extra";

import type { KioskDownloader } from "../..";
import type { KioApiClient } from "./kio-api-client";
import type { DownloadTransferMetrics } from "./metrics";
import type { DownloadRepository } from "./repository";
import type { TransferItApiClient } from "./transfer-it-api-client";
import type {
    DownloadChunkRow,
    DownloadCollectionRow,
    DownloadFileRow,
    SchedulerSettings,
    SegmentDescriptor,
    ZipEntryStoredMeta,
} from "./types";

import { TransferProgressBatcher } from "../transfer-progress-batcher";
import { getStagingPartPath, PartFileWriter } from "./part-file";
import { GlobalSegmentPool } from "./segment-pool";
import { TransferChunkPool, parseTransferNodeKey } from "./transfer-chunk-pool";
import { openZipFileEntry } from "./zip-index";
import { inflateRawFile, zipDeflateProgressScale } from "./zip-inflate";
import { ZipRangeReader } from "./zip-range-reader";
import {
    buildZipEntrySegmentChunks,
    computeStoredDataOffset,
    supportsZipEntryPoolDownload,
} from "./zip-segment-map";

type SessionCacheEntry =
    | { kind: "kiosk"; cat: string; fetchedAt: number }
    | { kind: "transfer"; authPw?: string; fetchedAt: number };

function isActiveFileDownloadStatus(status: FileDownloadStatus | undefined) {
    return status === "downloading" || status === "inflating";
}

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

function clampInflateBufferBytes(value: number) {
    if (
        INFLATE_BUFFER_BYTES_OPTIONS.includes(
            value as (typeof INFLATE_BUFFER_BYTES_OPTIONS)[number],
        )
    ) {
        return value;
    }
    return INFLATE_BUFFER_BYTES_DEFAULT;
}

function ensurePositiveInteger(value: number, fallback: number) {
    if (!Number.isFinite(value) || value < 1) {
        return fallback;
    }
    return Math.max(1, Math.floor(value));
}

function parseZipEntryMeta(raw: string | null): ZipEntryStoredMeta {
    if (!raw) {
        throw new Error("Missing zip entry metadata.");
    }
    const parsed = JSON.parse(raw) as ZipEntryStoredMeta;
    if (
        typeof parsed.path !== "string" ||
        typeof parsed.offset !== "number" ||
        typeof parsed.uncompressedSize !== "number" ||
        typeof parsed.archiveSize !== "number"
    ) {
        throw new Error("Invalid zip entry metadata.");
    }
    return parsed;
}

async function* readableStreamToAsyncIterable(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            if (value && value.length > 0) {
                yield value;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

export class DownloadScheduler {
    private readonly activeCollections = new Set<string>();
    private readonly activeFilesByCollection = new Map<string, Set<string>>();
    private readonly fileControllers = new Map<string, AbortController>();
    private readonly manualCollections = new Set<string>();
    private readonly manualFiles = new Set<string>();
    private readonly sessionCache = new Map<string, SessionCacheEntry>();
    private readonly progressBatcher: TransferProgressBatcher;
    private readonly segmentPool: GlobalSegmentPool;
    private readonly transferPool: TransferChunkPool;
    private readonly fileStartOrder: string[] = [];
    private readonly collectionStartOrder: string[] = [];
    private readonly fileStartedAt = new Map<string, number>();
    private readonly collectionStartedAt = new Map<string, number>();
    private readonly collectionTimerStartedAt = new Map<string, number>();
    private readonly nonPooledZipEntries = new Set<string>();
    private isPumping = false;
    private pumpAgain = false;

    public constructor(
        private readonly kd: KioskDownloader,
        private readonly api: KioApiClient,
        private readonly transferApi: TransferItApiClient,
        private readonly repository: DownloadRepository,
        private readonly metrics: DownloadTransferMetrics,
        private readonly emitUpdate: (collectionId?: string) => Promise<void>,
        private readonly emitProgressUpdate: (
            collectionId: string,
            fileIds: Set<string>,
        ) => Promise<void>,
    ) {
        this.progressBatcher = new TransferProgressBatcher(
            async (collectionId, fileIds) => {
                await this.emitProgressUpdate(collectionId, fileIds);
                const activeFileIds = this.activeFilesByCollection.get(collectionId);
                if (!activeFileIds || activeFileIds.size === 0) {
                    this.progressBatcher.deactivate(collectionId);
                    return;
                }
                for (const fileId of activeFileIds) {
                    this.progressBatcher.mark(collectionId, fileId);
                }
            },
            (error) => this.kd.logger.error(error, "DownloadScheduler:emitProgressUpdate"),
        );
        this.segmentPool = new GlobalSegmentPool({
            kd: this.kd,
            api: this.api,
            repository: this.repository,
            metrics: this.metrics,
            onChunkSettled: () => {
                void this.schedule();
            },
        });
        this.transferPool = new TransferChunkPool({
            kd: this.kd,
            api: this.transferApi,
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
            this.transferPool.cancelSession(fileId);
            this.fileControllers.get(fileId)?.abort();
            this.metrics.clearFile(fileId);
        }
        this.deactivateCollectionTransfer(collectionId);
        this.sessionCache.delete(collectionId);
        this.clearCollectionStartTracking(collectionId);
        this.stopCollectionTimer(collectionId);
        this.progressBatcher.deactivate(collectionId);
    }

    public resumeCollection(collectionId: string) {
        this.manualCollections.add(collectionId);
        void this.schedule();
    }

    public pauseFile(fileId: string) {
        this.manualFiles.delete(fileId);
        this.nonPooledZipEntries.delete(fileId);
        this.segmentPool.cancelSession(fileId);
        this.transferPool.cancelSession(fileId);
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
            this.transferPool.cancelSession(fileId);
            this.fileControllers.get(fileId)?.abort();
            this.metrics.clearFile(fileId);
            this.clearFileStartTracking(fileId);
        }
        this.deactivateCollectionTransfer(collectionId);
        this.manualCollections.delete(collectionId);
        this.sessionCache.delete(collectionId);
        this.clearCollectionStartTracking(collectionId);
        this.stopCollectionTimer(collectionId);
        this.progressBatcher.deactivate(collectionId);
    }

    public destroy() {
        this.progressBatcher.destroy();
        for (const collectionId of [...this.collectionTimerStartedAt.keys()]) {
            this.stopCollectionTimer(collectionId);
        }
    }

    public async cleanupPartFiles(collection: DownloadCollectionRow, files: DownloadFileRow[]) {
        await Promise.all(
            files.map(async (file) => {
                const partPath = this.getPartPath(collection, file);
                const stagingPath = getStagingPartPath(partPath);
                await fse.remove(partPath).catch(() => undefined);
                await PartFileWriter.removeSidecar(partPath);
                await fse.remove(stagingPath).catch(() => undefined);
                await PartFileWriter.removeSidecar(stagingPath);
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
        this.transferPool.resize(segmentPoolSize);
        const collections = this.repository.listRunnableCollections();

        for (const collection of collections) {
            const hasPending = this.repository.hasPendingFile(
                collection.id,
                this.fileControllers.keys(),
            );
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
            inflateBufferBytes: clampInflateBufferBytes(
                await this.kd.setting.transfer.getInflateBufferBytes(),
            ),
        };
    }

    private pickNextFile(collectionId: string) {
        return this.repository.getNextPendingFile(
            collectionId,
            this.manualFiles,
            this.fileControllers.keys(),
        );
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

    private getTotalInFlight() {
        return this.segmentPool.getTotalInFlight() + this.transferPool.getTotalInFlight();
    }

    private getOutstandingChunks(fileId: string) {
        const segmentOutstanding = this.segmentPool.getOutstandingChunks(fileId);
        if (segmentOutstanding !== null) {
            return segmentOutstanding;
        }
        return this.transferPool.getOutstandingChunks(fileId);
    }

    private canStartFile(collectionId: string, segmentPoolSize: number) {
        const activeFileIds = [...(this.activeFilesByCollection.get(collectionId) ?? [])].filter(
            (fileId) => this.fileControllers.has(fileId),
        );

        if (activeFileIds.length === 0) {
            return true;
        }

        if (this.getTotalInFlight() >= segmentPoolSize) {
            return false;
        }

        let outstandingChunks = 0;
        let nonPooledCount = 0;
        for (const fileId of activeFileIds) {
            const outstanding = this.getOutstandingChunks(fileId);
            if (outstanding === null) {
                if (this.nonPooledZipEntries.has(fileId)) {
                    nonPooledCount += 1;
                    continue;
                }
                // Still in pre-register setup; do not start more files in this collection.
                return false;
            }
            outstandingChunks += outstanding;
        }

        if (nonPooledCount >= 1) {
            return false;
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
        this.progressBatcher.activate(collection.id);

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
        const wasTerminal =
            collection?.status === "completed" ||
            collection?.status === "error" ||
            collection?.status === "expired" ||
            collection?.status === "paused";
        if (
            updatedCollection &&
            (updatedCollection.status === "completed" ||
                updatedCollection.status === "error" ||
                updatedCollection.status === "expired" ||
                updatedCollection.status === "paused")
        ) {
            this.stopCollectionTimer(collectionId);
            this.progressBatcher.deactivate(collectionId);
            if (!wasTerminal) {
                await this.emitUpdate(collectionId);
            }
        } else {
            this.progressBatcher.mark(collectionId, fileId);
        }
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
            this.progressBatcher.deactivate(collectionId);
            await this.emitUpdate(collectionId);
            return;
        }

        let partWriter: PartFileWriter | null = null;

        try {
            this.repository.resetRunningChunksForFile(fileId);
            this.repository.markFileStatus(fileId, "downloading");
            this.repository.markCollectionStatus(collectionId, "downloading");
            this.progressBatcher.mark(collectionId, fileId);

            if (file.sourceKind === "zip_entry") {
                if ((collection.provider ?? "kiosk") === "transfer") {
                    throw new Error("ZIP entry downloads are not supported for transfer.it.");
                }
                await this.runZipEntry(collection, file, settings, controller);
                return;
            }

            if ((collection.provider ?? "kiosk") === "transfer") {
                await this.runTransferFile(collection, file, settings, controller);
                return;
            }

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
                    if (isActiveFileDownloadStatus(currentFile?.status)) {
                        this.repository.markFileStatus(fileId, "pending");
                        this.progressBatcher.mark(collectionId, fileId);
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
                    if (isActiveFileDownloadStatus(currentFile?.status)) {
                        this.repository.markFileStatus(fileId, "pending");
                    }
                }
                return;
            }

            const message = toErrorMessage(error);
            if (currentFile) {
                this.repository.markFileStatus(fileId, "error", message);
                this.progressBatcher.mark(collectionId, fileId);
            }
            this.kd.logger.error(error, "DownloadService:runFile");
        } finally {
            await partWriter?.close();
            this.metrics.clearFile(fileId);
        }
    }

    private async runZipEntry(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        settings: SchedulerSettings,
        controller: AbortController,
    ) {
        const signal = controller.signal;
        let meta = parseZipEntryMeta(file.zipEntryJson);
        const partPath = this.getPartPath(collection, file);
        const stagingPath = getStagingPartPath(partPath);

        if (file.size === 0) {
            await this.finalizeFile(collection, file);
            return;
        }

        if (!supportsZipEntryPoolDownload(meta)) {
            this.nonPooledZipEntries.add(file.id);
            try {
                await this.runZipEntryWithZipJs(collection, file, meta, settings, controller);
            } finally {
                this.nonPooledZipEntries.delete(file.id);
            }
            return;
        }

        let partWriter: PartFileWriter | null = null;
        let removeStaging = false;

        try {
            const cat = await this.getCollectionToken(collection);
            const segments = await this.api.getSegments(file.remoteId, cat);

            meta = await this.ensureZipEntryDataOffset(collection, file, meta, segments, signal);
            file = this.repository.getFile(file.id) ?? file;

            const spans = buildZipEntrySegmentChunks(
                meta.dataOffset!,
                meta.compressedSize,
                collection.segmentSize,
                meta.archiveSize,
            );
            if (spans.length === 0) {
                throw new Error("ZIP entry payload maps to zero segment chunks.");
            }

            await this.ensureZipEntryChunkLayout(file, spans, partPath, stagingPath);
            file = this.repository.getFile(file.id) ?? file;

            const isDeflate = meta.compressionMethod === 8;
            const downloadPartPath = isDeflate ? stagingPath : partPath;
            const downloadPartSize = isDeflate ? meta.compressedSize : meta.uncompressedSize;

            let chunks = this.repository.listChunks(file.id);
            await this.validateCompletedChunksAt(downloadPartPath, chunks);
            if (isDeflate) {
                const scale = zipDeflateProgressScale(meta.compressedSize, meta.uncompressedSize);
                this.repository.syncScaledDownloadedBytes(
                    file.id,
                    scale.sourceTotal,
                    scale.displayTotal,
                );
            } else {
                this.repository.syncFileDownloadedBytes(file.id);
            }

            chunks = this.repository.listChunks(file.id);
            if (this.areChunksComplete(chunks)) {
                if (isDeflate) {
                    await this.inflateZipEntryStaging(
                        collection,
                        file,
                        meta,
                        stagingPath,
                        partPath,
                        signal,
                        settings.inflateBufferBytes,
                    );
                }
                await this.finalizeFile(collection, file);
                removeStaging = true;
                return;
            }

            const pendingChunks = chunks.filter(
                (chunk) => chunk.status === "pending" || chunk.status === "error",
            );
            const ranges = new Map(
                spans.map((span) => [
                    span.chunkIndex,
                    {
                        segmentIndex: span.segmentIndex,
                        localStart: span.localStart,
                        localEnd: span.localEnd,
                    },
                ]),
            );

            partWriter = new PartFileWriter(downloadPartPath);
            await partWriter.open(downloadPartSize, chunks.length);

            const outcome = await this.segmentPool.register({
                collection,
                file,
                segments,
                partWriter,
                controller,
                maxChunkRetries: settings.maxChunkRetries,
                streamWriteBatchBytes: settings.streamWriteBatchBytes,
                priority: this.getFilePriority(collection.id, file.id),
                chunks: pendingChunks,
                startedAt: this.fileStartedAt.get(file.id) ?? Date.now(),
                collectionStartedAt: this.collectionStartedAt.get(collection.id) ?? Date.now(),
                mode: "byte-range",
                ranges,
                progressScale: isDeflate
                    ? zipDeflateProgressScale(meta.compressedSize, meta.uncompressedSize)
                    : undefined,
            });

            if (outcome === "paused") {
                if (!this.repository.hasErroredChunk(file.id)) {
                    const currentFile = this.repository.getFile(file.id);
                    if (isActiveFileDownloadStatus(currentFile?.status)) {
                        this.repository.markFileStatus(file.id, "pending");
                        this.progressBatcher.mark(collection.id, file.id);
                    }
                }
                return;
            }

            if (outcome === "failed") {
                return;
            }

            if (!this.areChunksComplete(this.repository.listChunks(file.id))) {
                return;
            }

            if (isDeflate) {
                await this.inflateZipEntryStaging(
                    collection,
                    file,
                    meta,
                    stagingPath,
                    partPath,
                    signal,
                    settings.inflateBufferBytes,
                );
            }
            await this.finalizeFile(collection, file);
            removeStaging = true;
        } catch (error) {
            this.repository.resetRunningChunksForFile(file.id);
            const currentFile = this.repository.getFile(file.id);

            if ((error instanceof DOMException && error.name === "AbortError") || signal.aborted) {
                // Drop partial inflate output; keep staging + completed compressed chunks for resume.
                if (meta.compressionMethod === 8) {
                    await fse.remove(partPath).catch(() => undefined);
                    await PartFileWriter.removeSidecar(partPath);
                }
                if (!this.repository.hasErroredChunk(file.id)) {
                    if (isActiveFileDownloadStatus(currentFile?.status)) {
                        this.repository.markFileStatus(file.id, "pending");
                    }
                }
                return;
            }

            const message = toErrorMessage(error);
            if (currentFile) {
                this.repository.markFileStatus(file.id, "error", message);
                this.progressBatcher.mark(collection.id, file.id);
            }
            this.kd.logger.error(error, "DownloadService:runZipEntry");
        } finally {
            await partWriter?.close();
            if (removeStaging) {
                await this.cleanupZipEntryStaging(partPath);
            }
            this.metrics.clearFile(file.id);
            this.progressBatcher.mark(collection.id, file.id);
        }
    }

    private async runZipEntryWithZipJs(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        meta: ZipEntryStoredMeta,
        settings: SchedulerSettings,
        controller: AbortController,
    ) {
        const signal = controller.signal;
        const chunk = this.repository.listChunks(file.id)[0];
        if (!chunk) {
            throw new Error("Missing zip entry chunk descriptor.");
        }

        const partPath = this.getPartPath(collection, file);
        const chunkRange = { chunkIndex: 0, offset: 0, size: file.size };
        if (await PartFileWriter.isChunkValid(partPath, chunkRange)) {
            if (chunk.status !== "completed") {
                this.repository.markChunkCompleted(chunk, file.size);
                this.repository.syncFileDownloadedBytes(file.id);
            }
            await this.finalizeFile(collection, file);
            return;
        }

        await fse.remove(partPath);
        await PartFileWriter.removeSidecar(partPath);
        this.repository.markChunkPending(file.id, 0);
        this.repository.syncFileDownloadedBytes(file.id);

        this.repository.markChunkDownloading(chunk);
        this.metrics.registerFile(collection.id, file.id, 0);

        const partWriter = new PartFileWriter(partPath);
        await partWriter.open(file.size, 1);

        try {
            const cat = await this.getCollectionToken(collection);
            const segments = await this.api.getSegments(file.remoteId, cat);
            const opened = await openZipFileEntry({
                kd: this.kd,
                segments,
                segmentSize: collection.segmentSize,
                fileSize: meta.archiveSize,
                entryPath: meta.path,
                zipPassword: meta.password,
                signal,
            });
            try {
                const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
                const getDataPromise = opened.entry.getData(writable, {
                    password: meta.password,
                    signal,
                });
                const bytes = await partWriter.writeChunkFromStream(
                    0,
                    0,
                    readableStreamToAsyncIterable(readable),
                    meta.uncompressedSize,
                    settings.streamWriteBatchBytes,
                    {
                        onTransferProgress: (transferredBytes) => {
                            this.metrics.setChunkTransferProgress(file.id, 0, transferredBytes);
                        },
                        onWriteProgress: (writtenBytes) => {
                            this.metrics.setChunkWriteProgress(file.id, 0, writtenBytes);
                        },
                    },
                );
                await getDataPromise;

                if (signal.aborted) {
                    this.repository.markChunkPending(file.id, 0);
                    this.repository.markFileStatus(file.id, "pending");
                    return;
                }

                this.repository.markChunkCompleted(chunk, bytes);
                this.repository.syncFileDownloadedBytes(file.id);
                const updated = this.repository.getFile(file.id);
                if (updated) {
                    this.metrics.clearChunk(file.id, 0, updated.downloadedBytes);
                }
                await this.finalizeFile(collection, file);
            } finally {
                await opened.zipReader.close();
            }
        } catch (error) {
            if ((error instanceof DOMException && error.name === "AbortError") || signal.aborted) {
                this.repository.markChunkPending(file.id, 0);
                if (isActiveFileDownloadStatus(this.repository.getFile(file.id)?.status)) {
                    this.repository.markFileStatus(file.id, "pending");
                }
                return;
            }
            const message = toErrorMessage(error);
            this.repository.markChunkError(chunk, message);
            this.repository.markFileStatus(file.id, "error", message);
            this.progressBatcher.mark(collection.id, file.id);
            this.kd.logger.error(error, "DownloadService:runZipEntry");
        } finally {
            await partWriter.close();
            this.metrics.clearFile(file.id);
            this.progressBatcher.mark(collection.id, file.id);
        }
    }

    private async ensureZipEntryDataOffset(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        meta: ZipEntryStoredMeta,
        segments: SegmentDescriptor[],
        signal: AbortSignal,
    ) {
        if (typeof meta.dataOffset === "number" && meta.dataOffset >= 0) {
            return meta;
        }

        const rangeReader = new ZipRangeReader({
            kd: this.kd,
            segments,
            segmentSize: collection.segmentSize,
            fileSize: meta.archiveSize,
            signal,
        });
        const headerFields = await rangeReader.readUint8Array(meta.offset + 26, 4);
        const dataOffset = computeStoredDataOffset(meta.offset, headerFields);
        const updated = { ...meta, dataOffset };
        this.repository.updateZipEntryJson(file.id, updated);
        return updated;
    }

    private async ensureZipEntryChunkLayout(
        file: DownloadFileRow,
        spans: ReturnType<typeof buildZipEntrySegmentChunks>,
        partPath: string,
        stagingPath: string,
    ) {
        const existing = this.repository.listChunks(file.id);
        const layoutMatches =
            existing.length === spans.length &&
            spans.every((span, index) => {
                const chunk = existing[index];
                return (
                    chunk &&
                    chunk.chunkIndex === span.chunkIndex &&
                    chunk.offset === span.offset &&
                    chunk.size === span.size
                );
            });

        if (layoutMatches) {
            return;
        }

        this.repository.deleteAllChunksForFile(file.id);
        await fse.remove(partPath).catch(() => undefined);
        await PartFileWriter.removeSidecar(partPath);
        await fse.remove(stagingPath).catch(() => undefined);
        await PartFileWriter.removeSidecar(stagingPath);
        this.repository.syncFileDownloadedBytes(file.id);
    }

    private async inflateZipEntryStaging(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        meta: ZipEntryStoredMeta,
        stagingPath: string,
        partPath: string,
        signal: AbortSignal,
        inflateBufferBytes: number,
    ) {
        // Hold UI near 100% while inflating; reserve the final byte until completeFile.
        const almostDone = Math.max(0, meta.uncompressedSize - 1);
        this.repository.markFileStatus(file.id, "inflating");
        this.repository.recomputeCollectionStatus(collection.id);
        this.metrics.registerFile(collection.id, file.id, almostDone);
        this.repository.setFileDownloadedBytes(file.id, almostDone);
        this.progressBatcher.mark(collection.id, file.id);

        try {
            await inflateRawFile(
                stagingPath,
                partPath,
                meta.uncompressedSize,
                inflateBufferBytes,
                signal,
            );
        } catch (error) {
            await fse.remove(partPath).catch(() => undefined);
            await PartFileWriter.removeSidecar(partPath);
            throw error;
        }

        this.repository.setFileDownloadedBytes(file.id, almostDone);
        this.progressBatcher.mark(collection.id, file.id);
    }

    private deactivateCollectionTransfer(collectionId: string) {
        this.activeCollections.delete(collectionId);
        this.activeFilesByCollection.delete(collectionId);
        this.metrics.clearCollection(collectionId);
    }

    private async runTransferFile(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        settings: SchedulerSettings,
        controller: AbortController,
    ) {
        let partWriter: PartFileWriter | null = null;

        const chunks = this.repository.listChunks(file.id);
        await this.validateCompletedChunks(collection, file, chunks);
        this.repository.syncFileDownloadedBytes(file.id);

        const refreshedFile = this.repository.getFile(file.id);
        const refreshedCollection = this.repository.getCollection(collection.id);
        if (!refreshedFile || !refreshedCollection) {
            return;
        }

        const refreshedChunks = this.repository.listChunks(refreshedFile.id);
        if (refreshedFile.size === 0 || this.areChunksComplete(refreshedChunks)) {
            await this.finalizeFile(refreshedCollection, refreshedFile);
            return;
        }

        const authPw = this.getTransferAuth(refreshedCollection);
        const nodeKey = parseTransferNodeKey(refreshedFile.sourceMetaJson);
        const pendingChunks = refreshedChunks.filter(
            (chunk) => chunk.status === "pending" || chunk.status === "error",
        );
        partWriter = new PartFileWriter(this.getPartPath(refreshedCollection, refreshedFile));
        await partWriter.open(refreshedFile.size, refreshedChunks.length);

        try {
            const outcome = await this.transferPool.register({
                collection: refreshedCollection,
                file: refreshedFile,
                nodeKey,
                authPw,
                partWriter,
                controller,
                maxChunkRetries: settings.maxChunkRetries,
                priority: this.getFilePriority(refreshedCollection.id, refreshedFile.id),
                chunks: pendingChunks,
                startedAt: this.fileStartedAt.get(refreshedFile.id) ?? Date.now(),
                collectionStartedAt:
                    this.collectionStartedAt.get(refreshedCollection.id) ?? Date.now(),
            });

            if (outcome === "paused") {
                if (!this.repository.hasErroredChunk(refreshedFile.id)) {
                    const currentFile = this.repository.getFile(refreshedFile.id);
                    if (isActiveFileDownloadStatus(currentFile?.status)) {
                        this.repository.markFileStatus(refreshedFile.id, "pending");
                        this.progressBatcher.mark(refreshedCollection.id, refreshedFile.id);
                    }
                }
                return;
            }

            if (outcome === "failed") {
                return;
            }

            if (this.areChunksComplete(this.repository.listChunks(refreshedFile.id))) {
                await this.finalizeFile(refreshedCollection, refreshedFile);
            }
        } finally {
            await partWriter?.close();
        }
    }

    private async getCollectionToken(collection: DownloadCollectionRow) {
        const cached = this.sessionCache.get(collection.id);
        if (cached?.kind === "kiosk") {
            return cached.cat;
        }

        const refreshed = await this.api.refreshCollectionToken(collection);
        this.repository.updateCollectionFreshMeta(collection.id, {
            expires: refreshed.expires,
        });
        this.sessionCache.set(collection.id, {
            kind: "kiosk",
            cat: refreshed.cat,
            fetchedAt: Date.now(),
        });
        return refreshed.cat;
    }

    private getTransferAuth(collection: DownloadCollectionRow) {
        const cached = this.sessionCache.get(collection.id);
        if (cached?.kind === "transfer") {
            return cached.authPw;
        }

        const authPw = this.transferApi.deriveAuthPw(collection);
        this.sessionCache.set(collection.id, {
            kind: "transfer",
            authPw,
            fetchedAt: Date.now(),
        });
        return authPw;
    }

    private async validateCompletedChunks(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        chunks: DownloadChunkRow[],
    ) {
        await this.validateCompletedChunksAt(this.getPartPath(collection, file), chunks);
    }

    private async validateCompletedChunksAt(partPath: string, chunks: DownloadChunkRow[]) {
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
        return chunks.length > 0 && chunks.every((chunk) => chunk.status === "completed");
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
        // Mark complete before slow staging cleanup so the UI does not sit at 100%.
        this.repository.completeFile(file.id);
        this.progressBatcher.mark(collection.id, file.id);
    }

    private async cleanupZipEntryStaging(partPath: string) {
        const stagingPath = getStagingPartPath(partPath);
        await fse.remove(stagingPath).catch(() => undefined);
        await PartFileWriter.removeSidecar(stagingPath);
    }

    private getPartPath(collection: DownloadCollectionRow, file: DownloadFileRow) {
        return `${this.getFinalPath(collection, file)}.part`;
    }

    private getFinalPath(collection: DownloadCollectionRow, file: DownloadFileRow) {
        return path.join(
            collection.savePath,
            this.kd.lib.fs.getSafeRelativePath(file.path, {
                asciiFilenames: collection.asciiFilenames === 1,
            }),
        );
    }
}
