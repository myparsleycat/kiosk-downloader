import { toErrorMessage } from "@shared/utils";

import type { KioskDownloader } from "../..";
import type { KioApiClient } from "./kio-api-client";
import type { DownloadTransferMetrics } from "./metrics";
import type { PartFileWriter } from "./part-file";
import type { DownloadRepository } from "./repository";
import type {
    DownloadChunkRow,
    DownloadCollectionRow,
    DownloadFileRow,
    SegmentDescriptor,
    SegmentDownloadMode,
    ZipEntrySegmentRange,
} from "./types";

import {
    SLOW_CHUNK_MAX_RECONNECTS,
    SLOW_CHUNK_THRESHOLD_RATIO,
    SlowChunkMonitor,
    isAbortError,
    sleepWithAbort,
    slowReconnectDelayMs,
} from "./slow-chunk-monitor";

export type FileDownloadOutcome = "completed" | "paused" | "failed";

export type FileDownloadRegistration = {
    collection: DownloadCollectionRow;
    file: DownloadFileRow;
    segments: SegmentDescriptor[];
    partWriter: PartFileWriter;
    controller: AbortController;
    maxChunkRetries: number;
    streamWriteBatchBytes: number;
    priority: number;
    chunks: DownloadChunkRow[];
    startedAt: number;
    collectionStartedAt: number;
    mode?: SegmentDownloadMode;
    ranges?: Map<number, ZipEntrySegmentRange>;
    /** Scale completed chunk bytes (e.g. compressed → uncompressed) for UI progress. */
    progressScale?: { sourceTotal: number; displayTotal: number };
};

type SegmentWorkItem = {
    priority: number;
    order: number;
    sessionId: string;
    chunk: DownloadChunkRow;
};

type FileDownloadSession = {
    id: string;
    registration: FileDownloadRegistration;
    remainingChunks: number;
    inFlightChunks: number;
    failed: boolean;
    aborted: boolean;
    startedAt: number;
    collectionId: string;
    collectionStartedAt: number;
    resolve: (outcome: FileDownloadOutcome) => void;
};

type SegmentPoolDeps = {
    kd: KioskDownloader;
    api: KioApiClient;
    repository: DownloadRepository;
    metrics: DownloadTransferMetrics;
    onChunkSettled: () => void;
    onProgress: (collectionId: string, fileId: string) => void;
};

function chunkBackoffMs(attempt: number) {
    return 1000 * 2 ** (attempt - 1);
}

export class GlobalSegmentPool {
    private targetWorkers = 0;
    private runningWorkers = 0;
    private nextOrder = 0;
    private lastClaimedCollectionId: string | null = null;
    private readonly queue: SegmentWorkItem[] = [];
    private readonly sessions = new Map<string, FileDownloadSession>();
    private readonly slowChunkMonitor = new SlowChunkMonitor();

    public constructor(private readonly deps: SegmentPoolDeps) {}

    public getOutstandingChunks(fileId: string) {
        const session = this.sessions.get(fileId);
        if (!session) {
            return null;
        }

        // remainingChunks already counts in-flight work; adding inFlightChunks double-counts.
        return session.remainingChunks;
    }

    public getTotalInFlight() {
        let total = 0;
        for (const session of this.sessions.values()) {
            total += session.inFlightChunks;
        }
        return total;
    }

    public getTargetWorkers() {
        return this.targetWorkers;
    }

    public getRunningWorkers() {
        return this.runningWorkers;
    }

    public resize(maxWorkers: number) {
        this.targetWorkers = Math.max(1, Math.floor(maxWorkers));
        this.ensureWorkers();
    }

    private ensureWorkers() {
        const activeCollectionCount = new Set(
            [...this.sessions.values()]
                .filter((session) => !session.failed && !session.aborted)
                .map((session) => session.collectionId),
        ).size;
        const targetWorkers = Math.min(
            this.targetWorkers === 0
                ? 0
                : this.targetWorkers + Math.max(0, activeCollectionCount - 1),
            this.queue.length + this.runningWorkers,
        );
        while (this.runningWorkers < targetWorkers) {
            this.runningWorkers += 1;
            void this.workerLoop();
        }
    }

    public register(registration: FileDownloadRegistration) {
        if (registration.chunks.length === 0) {
            return Promise.resolve("completed" as const);
        }

        return new Promise<FileDownloadOutcome>((resolve) => {
            const session: FileDownloadSession = {
                id: registration.file.id,
                registration,
                remainingChunks: registration.chunks.length,
                inFlightChunks: 0,
                failed: false,
                aborted: false,
                startedAt: registration.startedAt,
                collectionId: registration.collection.id,
                collectionStartedAt: registration.collectionStartedAt,
                resolve,
            };
            this.sessions.set(session.id, session);
            this.deps.metrics.registerFile(
                registration.collection.id,
                registration.file.id,
                registration.file.downloadedBytes,
            );

            this.queue.push(
                ...registration.chunks.map((chunk, index) => ({
                    priority: registration.priority,
                    order: this.nextOrder + index,
                    sessionId: session.id,
                    chunk,
                })),
            );
            this.queue.sort(compareWorkItems);
            this.nextOrder += registration.chunks.length;
            this.deps.onChunkSettled();
            this.ensureWorkers();
        });
    }

    public cancelSession(fileId: string) {
        const session = this.sessions.get(fileId);
        if (!session) {
            return;
        }

        session.aborted = true;
        this.removeSessionItemsFromQueue(fileId);
        this.tryCompleteSession(session);
    }

    private compareAndClaimNext() {
        while (this.queue.length > 0) {
            const availableCollectionIds = [
                ...new Set(
                    this.queue.flatMap((candidate) => {
                        const candidateSession = this.sessions.get(candidate.sessionId);
                        return candidateSession &&
                            !candidateSession.failed &&
                            !candidateSession.aborted
                            ? [candidateSession.collectionId]
                            : [];
                    }),
                ),
            ];
            const previousIndex = this.lastClaimedCollectionId
                ? availableCollectionIds.indexOf(this.lastClaimedCollectionId)
                : -1;
            const nextCollectionId =
                availableCollectionIds[(previousIndex + 1) % availableCollectionIds.length];
            const nextCollectionIndex = this.queue.findIndex((candidate) => {
                const candidateSession = this.sessions.get(candidate.sessionId);
                return candidateSession?.collectionId === nextCollectionId;
            });
            const item = this.queue.splice(nextCollectionIndex < 0 ? 0 : nextCollectionIndex, 1)[0];
            const session = this.sessions.get(item.sessionId);
            if (!session || session.failed || session.aborted) {
                continue;
            }
            session.inFlightChunks += 1;
            this.lastClaimedCollectionId = session.collectionId;
            return { item, session };
        }
        return null;
    }

    private removeSessionItemsFromQueue(sessionId: string) {
        for (let index = this.queue.length - 1; index >= 0; index -= 1) {
            if (this.queue[index].sessionId === sessionId) {
                this.queue.splice(index, 1);
            }
        }
    }

    private tryCompleteSession(session: FileDownloadSession) {
        if (session.failed) {
            this.finishSession(session, "failed");
            return;
        }

        if (session.aborted && session.inFlightChunks === 0) {
            this.finishSession(session, "paused");
            return;
        }

        if (session.remainingChunks === 0 && session.inFlightChunks === 0) {
            this.finishSession(session, "completed");
        }
    }

    private finishSession(session: FileDownloadSession, outcome: FileDownloadOutcome) {
        if (!this.sessions.has(session.id)) {
            return;
        }

        this.sessions.delete(session.id);
        session.resolve(outcome);
    }

    private async workerLoop() {
        try {
            while (true) {
                const claimed = this.compareAndClaimNext();
                if (!claimed) {
                    return;
                }

                await this.processChunk(claimed.session, claimed.item.chunk);
            }
        } finally {
            this.runningWorkers -= 1;
            this.ensureWorkers();
        }
    }

    private async processChunk(session: FileDownloadSession, chunk: DownloadChunkRow) {
        const {
            collection,
            file,
            segments,
            partWriter,
            controller,
            maxChunkRetries,
            streamWriteBatchBytes,
            mode = "full-segment",
            ranges,
            progressScale,
        } = session.registration;
        const maxAttempts = maxChunkRetries + 1;

        const releaseInFlight = () => {
            session.inFlightChunks -= 1;
            this.tryCompleteSession(session);
            this.deps.onChunkSettled();
            this.ensureWorkers();
        };

        if (session.failed || session.aborted || controller.signal.aborted) {
            releaseInFlight();
            return;
        }

        const range = mode === "byte-range" ? ranges?.get(chunk.chunkIndex) : undefined;
        if (mode === "byte-range" && !range) {
            this.failSession(
                session,
                `Missing byte-range mapping for chunk ${chunk.chunkIndex}.`,
                controller,
            );
            releaseInFlight();
            return;
        }

        const segmentIndex = mode === "byte-range" ? range!.segmentIndex : chunk.chunkIndex;
        const segment = segments[segmentIndex];
        if (!segment) {
            this.failSession(session, `Missing segment ${segmentIndex}.`, controller);
            releaseInFlight();
            return;
        }

        let errorAttempt = 1;
        let slowReconnects = 0;
        let needsMarkDownloading = true;
        let committedBytes = Math.max(0, Math.min(chunk.size, chunk.downloadedBytes));

        while (errorAttempt <= maxAttempts) {
            if (session.failed || session.aborted || controller.signal.aborted) {
                this.deps.repository.markChunkPending(file.id, chunk.chunkIndex);
                releaseInFlight();
                return;
            }

            if (needsMarkDownloading) {
                this.deps.repository.markChunkDownloading(chunk);
                needsMarkDownloading = false;
            }

            const attemptController = new AbortController();
            const onSessionAbort = () => {
                if (!attemptController.signal.aborted) {
                    attemptController.abort();
                }
            };
            const transfer = this.slowChunkMonitor.register({
                fileId: file.id,
                chunkIndex: chunk.chunkIndex,
                chunkSize: chunk.size,
                cohortKey: `${segment.type}:${mode}`,
                initialTransferredBytes: committedBytes,
                attemptController,
                slowReconnects,
            });
            const resumeOffset = committedBytes;

            try {
                if (controller.signal.aborted) {
                    onSessionAbort();
                } else {
                    controller.signal.addEventListener("abort", onSessionAbort);
                }

                const onPhaseChange = (phase: "network" | "bandwidth-wait") => {
                    this.slowChunkMonitor.setPhase(transfer.key, phase);
                };
                const source =
                    mode === "byte-range" && range
                        ? this.deps.api.streamSegmentRange(
                              collection.id,
                              segment,
                              {
                                  localStart: range.localStart + resumeOffset,
                                  localEnd: range.localEnd,
                              },
                              attemptController.signal,
                              onPhaseChange,
                              resumeOffset > 0,
                          )
                        : this.deps.api.streamSegment(
                              collection.id,
                              segment,
                              chunk,
                              attemptController.signal,
                              onPhaseChange,
                              resumeOffset,
                          );

                const scaleProgress = (bytes: number) => {
                    if (!progressScale || progressScale.sourceTotal <= 0) {
                        return bytes;
                    }
                    return Math.floor(
                        (bytes / progressScale.sourceTotal) * progressScale.displayTotal,
                    );
                };

                const bytes = await partWriter.writeChunkFromStream(
                    chunk.offset,
                    chunk.chunkIndex,
                    source,
                    chunk.size,
                    streamWriteBatchBytes,
                    {
                        onTransferProgress: (transferredBytes) => {
                            this.slowChunkMonitor.recordSample(
                                transfer.key,
                                resumeOffset + transferredBytes,
                            );
                            this.deps.metrics.setChunkTransferProgress(
                                file.id,
                                chunk.chunkIndex,
                                scaleProgress(resumeOffset + transferredBytes),
                            );
                            this.deps.onProgress(collection.id, file.id);
                        },
                        onWriteProgress: (writtenBytes) => {
                            committedBytes = writtenBytes;
                            this.deps.repository.markChunkPartial(
                                file.id,
                                chunk.chunkIndex,
                                writtenBytes,
                            );
                            this.deps.metrics.setChunkWriteProgress(
                                file.id,
                                chunk.chunkIndex,
                                scaleProgress(writtenBytes),
                            );
                            this.deps.onProgress(collection.id, file.id);
                        },
                        onWritePhaseChange: (writing) => {
                            this.slowChunkMonitor.setPhase(
                                transfer.key,
                                writing ? "disk-write" : "network",
                            );
                        },
                    },
                    { alreadyWritten: resumeOffset },
                );
                this.slowChunkMonitor.setPhase(transfer.key, "processing");
                this.deps.repository.markChunkCompleted(chunk, bytes);
                if (progressScale) {
                    this.deps.repository.syncScaledDownloadedBytes(
                        file.id,
                        progressScale.sourceTotal,
                        progressScale.displayTotal,
                    );
                } else {
                    this.deps.repository.addFileDownloadedBytes(file.id, bytes);
                }
                const updatedFile = this.deps.repository.getFile(file.id);
                if (updatedFile) {
                    this.deps.metrics.clearChunk(
                        file.id,
                        chunk.chunkIndex,
                        updatedFile.downloadedBytes,
                    );
                }
                session.remainingChunks -= 1;
                releaseInFlight();
                return;
            } catch (error) {
                const abortReason = transfer.abortReason;
                const detect = transfer.detect;
                const chunkSpeedBps = transfer.chunkSpeedBps;
                const peerMedianBps = transfer.peerMedianBps;
                const transferredBytes = transfer.transferredBytes;
                this.deps.metrics.clearChunk(file.id, chunk.chunkIndex);

                if (controller.signal.aborted || session.aborted) {
                    this.deps.repository.markChunkPending(file.id, chunk.chunkIndex);
                    releaseInFlight();
                    return;
                }

                if (abortReason === "slow-chunk" && slowReconnects < SLOW_CHUNK_MAX_RECONNECTS) {
                    slowReconnects += 1;
                    this.deps.kd.logger.warn(
                        {
                            channel: "segment-download",
                            reason: "slow-chunk-reconnect",
                            detect: detect ?? "relative",
                            fileId: file.id,
                            chunkIndex: chunk.chunkIndex,
                            offset: chunk.offset,
                            expectedSize: chunk.size,
                            segmentType: segment.type,
                            chunkSpeedBps,
                            peerMedianBps,
                            thresholdRatio: SLOW_CHUNK_THRESHOLD_RATIO,
                            slowReconnect: slowReconnects,
                            maxSlowReconnects: SLOW_CHUNK_MAX_RECONNECTS,
                            transferredBytes,
                        },
                        "DownloadService:streamSegment",
                    );
                    try {
                        await sleepWithAbort(slowReconnectDelayMs(), controller.signal);
                    } catch (abortError) {
                        if (isAbortError(abortError) || controller.signal.aborted) {
                            this.deps.repository.markChunkPending(file.id, chunk.chunkIndex);
                            releaseInFlight();
                            return;
                        }
                        throw abortError;
                    }
                    continue;
                }

                if (abortReason === "slow-chunk") {
                    this.deps.kd.logger.warn(
                        {
                            channel: "segment-download",
                            reason: "slow-chunk-exhausted",
                            detect: detect ?? "relative",
                            fileId: file.id,
                            chunkIndex: chunk.chunkIndex,
                            offset: chunk.offset,
                            expectedSize: chunk.size,
                            segmentType: segment.type,
                            chunkSpeedBps,
                            peerMedianBps,
                            thresholdRatio: SLOW_CHUNK_THRESHOLD_RATIO,
                            slowReconnect: slowReconnects,
                            maxSlowReconnects: SLOW_CHUNK_MAX_RECONNECTS,
                            transferredBytes,
                        },
                        "DownloadService:streamSegment",
                    );
                } else if (isAbortError(error)) {
                    this.deps.repository.markChunkPending(file.id, chunk.chunkIndex);
                    releaseInFlight();
                    return;
                }

                const message =
                    abortReason === "slow-chunk"
                        ? "Slow chunk stalled after reconnects"
                        : toErrorMessage(error);
                if (errorAttempt < maxAttempts) {
                    this.deps.kd.logger.warn(
                        {
                            channel: "segment-download",
                            fileId: file.id,
                            chunkIndex: chunk.chunkIndex,
                            offset: chunk.offset,
                            expectedSize: chunk.size,
                            segmentType: segment.type,
                            attempt: errorAttempt,
                            maxRetries: maxChunkRetries,
                            message,
                        },
                        "DownloadService:streamSegment",
                    );
                    this.deps.repository.markChunkPending(file.id, chunk.chunkIndex);
                    try {
                        await sleepWithAbort(chunkBackoffMs(errorAttempt), controller.signal);
                    } catch (abortError) {
                        if (isAbortError(abortError) || controller.signal.aborted) {
                            releaseInFlight();
                            return;
                        }
                        throw abortError;
                    }
                    errorAttempt += 1;
                    needsMarkDownloading = true;
                    continue;
                }

                this.deps.kd.logger.error(
                    {
                        channel: "segment-download",
                        fileId: file.id,
                        chunkIndex: chunk.chunkIndex,
                        offset: chunk.offset,
                        expectedSize: chunk.size,
                        segmentType: segment.type,
                        attempt: errorAttempt,
                        maxRetries: maxChunkRetries,
                        aborted: false,
                        message,
                    },
                    "DownloadService:streamSegment",
                );
                this.deps.repository.markChunkError(chunk, message);
                this.failSession(session, message, controller);
                releaseInFlight();
                return;
            } finally {
                this.slowChunkMonitor.unregister(transfer.key);
                controller.signal.removeEventListener("abort", onSessionAbort);
            }
        }
    }

    private failSession(
        session: FileDownloadSession,
        message: string,
        controller: AbortController,
    ) {
        if (session.failed) {
            return;
        }

        session.failed = true;
        this.deps.repository.markFileStatus(session.registration.file.id, "error", message);
        controller.abort();
        this.removeSessionItemsFromQueue(session.id);
        this.tryCompleteSession(session);
    }
}

function compareWorkItems(left: SegmentWorkItem, right: SegmentWorkItem) {
    if (left.priority !== right.priority) {
        return left.priority - right.priority;
    }
    return left.order - right.order;
}
