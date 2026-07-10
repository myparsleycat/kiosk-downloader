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
};

type ByteSample = { t: number; b: number };

type SlowChunkDetect = "stall" | "relative";

type InFlightChunkTransfer = {
    key: string;
    fileId: string;
    chunkIndex: number;
    chunkSize: number;
    startedAt: number;
    lastProgressAt: number;
    samples: ByteSample[];
    transferredBytes: number;
    attemptController: AbortController;
    slowReconnects: number;
    slowTickCount: number;
    abortReason: "slow-chunk" | null;
    detect: SlowChunkDetect | null;
    chunkSpeedBps: number;
    peerMedianBps: number;
};

const SLOW_CHUNK_MAX_RECONNECTS = 2;
const SLOW_CHUNK_THRESHOLD_RATIO = 0.25;
const SLOW_CHUNK_MIN_OBSERVE_MS = 3000;
const SLOW_CHUNK_MIN_PEERS = 1;
const SLOW_CHUNK_CHECK_INTERVAL_MS = 1000;
const SLOW_CHUNK_SPEED_WINDOW_MS = 2000;
const SLOW_CHUNK_MIN_SPEED_SAMPLE_SPAN_MS = 500;
const SLOW_CHUNK_NEAR_COMPLETE_RATIO = 0.85;
const SLOW_CHUNK_REQUIRED_SLOW_TICKS = 2;
const SLOW_CHUNK_MIN_ABSOLUTE_BPS = 64 * 1024;
const SLOW_CHUNK_RECONNECT_DELAY_MS = 500;
const SLOW_CHUNK_RECONNECT_JITTER_MS = 250;
const SLOW_CHUNK_STALL_TIMEOUT_MS = 15_000;

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
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

function inFlightKey(fileId: string, chunkIndex: number) {
    return `${fileId}:${chunkIndex}`;
}

/** null = not measurable; number = measured bps (including 0 stall). */
function speedFromSamples(samples: ByteSample[], now: number): number | null {
    const window = samples.filter((sample) => now - sample.t <= SLOW_CHUNK_SPEED_WINDOW_MS);
    if (window.length < 2) {
        return null;
    }

    const first = window[0];
    const last = window[window.length - 1];
    if (!first || !last) {
        return null;
    }

    const elapsedMs = last.t - first.t;
    if (elapsedMs < SLOW_CHUNK_MIN_SPEED_SAMPLE_SPAN_MS) {
        return null;
    }

    return Math.max(0, (last.b - first.b) / (elapsedMs / 1000));
}

function median(values: number[]) {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((left, right) => left - right);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
    }
    return sorted[mid] ?? 0;
}

function slowReconnectDelayMs() {
    return (
        SLOW_CHUNK_RECONNECT_DELAY_MS +
        Math.floor(Math.random() * (SLOW_CHUNK_RECONNECT_JITTER_MS + 1))
    );
}

export class GlobalSegmentPool {
    private targetWorkers = 0;
    private runningWorkers = 0;
    private nextOrder = 0;
    private readonly queue: SegmentWorkItem[] = [];
    private readonly sessions = new Map<string, FileDownloadSession>();
    private readonly waiters: Array<() => void> = [];
    private readonly inFlightTransfers = new Map<string, InFlightChunkTransfer>();
    private slowChunkMonitorTimer: ReturnType<typeof setInterval> | null = null;

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

    public resize(maxWorkers: number) {
        this.targetWorkers = Math.max(1, Math.floor(maxWorkers));
        while (this.runningWorkers < this.targetWorkers) {
            this.runningWorkers += 1;
            void this.workerLoop(this.runningWorkers);
        }
        this.wakeWaiters();
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

            for (const chunk of registration.chunks) {
                this.queue.push({
                    priority: registration.priority,
                    order: this.nextOrder,
                    sessionId: session.id,
                    chunk,
                });
                this.nextOrder += 1;
            }

            this.queue.sort(compareWorkItems);
            this.deps.onChunkSettled();
            this.wakeWaiters();
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
        this.wakeWaiters();
    }

    private compareAndClaimNext() {
        if (this.queue.length === 0) {
            return null;
        }

        for (let index = 0; index < this.queue.length; index += 1) {
            const item = this.queue[index];
            if (!item) {
                continue;
            }

            const session = this.sessions.get(item.sessionId);
            if (!session || session.failed || session.aborted) {
                continue;
            }

            this.queue.splice(index, 1);
            session.inFlightChunks += 1;
            if (session.remainingChunks <= 1) {
                this.deps.onChunkSettled();
            }
            return { item, session };
        }

        return null;
    }

    private removeSessionItemsFromQueue(sessionId: string) {
        const remaining = this.queue.filter((item) => item.sessionId !== sessionId);
        this.queue.length = 0;
        this.queue.push(...remaining);
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

    private async workerLoop(workerId: number) {
        try {
            while (true) {
                if (workerId > this.targetWorkers) {
                    return;
                }

                const claimed = this.compareAndClaimNext();
                if (!claimed) {
                    await this.waitForWork();
                    continue;
                }

                await this.processChunk(claimed.session, claimed.item.chunk);
            }
        } finally {
            this.runningWorkers -= 1;
            if (this.runningWorkers < this.targetWorkers) {
                this.resize(this.targetWorkers);
            }
        }
    }

    private registerInFlightTransfer(input: {
        fileId: string;
        chunkIndex: number;
        chunkSize: number;
        attemptController: AbortController;
        slowReconnects: number;
    }) {
        const now = Date.now();
        const key = inFlightKey(input.fileId, input.chunkIndex);
        const transfer: InFlightChunkTransfer = {
            key,
            fileId: input.fileId,
            chunkIndex: input.chunkIndex,
            chunkSize: input.chunkSize,
            startedAt: now,
            lastProgressAt: now,
            samples: [{ t: now, b: 0 }],
            transferredBytes: 0,
            attemptController: input.attemptController,
            slowReconnects: input.slowReconnects,
            slowTickCount: 0,
            abortReason: null,
            detect: null,
            chunkSpeedBps: 0,
            peerMedianBps: 0,
        };
        this.inFlightTransfers.set(key, transfer);
        this.ensureSlowChunkMonitor();
        return transfer;
    }

    private recordInFlightTransferSample(key: string, transferredBytes: number) {
        const transfer = this.inFlightTransfers.get(key);
        if (!transfer) {
            return;
        }

        const now = Date.now();
        const normalized = Math.max(0, transferredBytes);
        if (normalized > transfer.transferredBytes) {
            transfer.lastProgressAt = now;
        }
        transfer.transferredBytes = normalized;
        transfer.samples.push({ t: now, b: normalized });
        transfer.samples = transfer.samples.filter(
            (sample) => now - sample.t <= SLOW_CHUNK_SPEED_WINDOW_MS,
        );
    }

    private unregisterInFlightTransfer(key: string) {
        this.inFlightTransfers.delete(key);
        this.stopSlowChunkMonitorIfIdle();
    }

    private ensureSlowChunkMonitor() {
        if (this.slowChunkMonitorTimer) {
            return;
        }

        this.slowChunkMonitorTimer = setInterval(() => {
            this.evaluateSlowChunks();
        }, SLOW_CHUNK_CHECK_INTERVAL_MS);
        this.slowChunkMonitorTimer.unref?.();
    }

    private stopSlowChunkMonitorIfIdle() {
        if (this.inFlightTransfers.size > 0 || !this.slowChunkMonitorTimer) {
            return;
        }

        clearInterval(this.slowChunkMonitorTimer);
        this.slowChunkMonitorTimer = null;
    }

    private evaluateSlowChunks() {
        const entries = [...this.inFlightTransfers.values()];
        if (entries.length === 0) {
            return;
        }

        const now = Date.now();
        const scored = entries.map((entry) => ({
            entry,
            speed: speedFromSamples(entry.samples, now),
        }));

        const stallCandidates: SlowAbortCandidate[] = [];
        const relativeCandidates: SlowAbortCandidate[] = [];

        for (const { entry, speed } of scored) {
            if (entry.slowReconnects >= SLOW_CHUNK_MAX_RECONNECTS) {
                entry.slowTickCount = 0;
                continue;
            }
            if (entry.abortReason !== null || entry.attemptController.signal.aborted) {
                continue;
            }

            const observedMs = now - entry.startedAt;
            if (observedMs < SLOW_CHUNK_MIN_OBSERVE_MS) {
                entry.slowTickCount = 0;
                continue;
            }

            const isStalled = now - entry.lastProgressAt >= SLOW_CHUNK_STALL_TIMEOUT_MS;
            if (isStalled) {
                entry.slowTickCount = 0;
                stallCandidates.push({
                    entry,
                    speed,
                    peerMedianBps: 0,
                    detect: "stall",
                });
                continue;
            }

            const nearComplete =
                entry.chunkSize > 0 &&
                entry.transferredBytes / entry.chunkSize >= SLOW_CHUNK_NEAR_COMPLETE_RATIO;
            if (nearComplete) {
                entry.slowTickCount = 0;
                continue;
            }

            if (speed === null || speed >= SLOW_CHUNK_MIN_ABSOLUTE_BPS) {
                entry.slowTickCount = 0;
                continue;
            }

            const peerMedianBps = this.peerMedianBps(scored, entry);
            if (peerMedianBps <= 0) {
                entry.slowTickCount = 0;
                continue;
            }

            if (speed >= peerMedianBps * SLOW_CHUNK_THRESHOLD_RATIO) {
                entry.slowTickCount = 0;
                continue;
            }

            entry.slowTickCount += 1;
            if (entry.slowTickCount >= SLOW_CHUNK_REQUIRED_SLOW_TICKS) {
                relativeCandidates.push({
                    entry,
                    speed,
                    peerMedianBps,
                    detect: "relative",
                });
            }
        }

        const pick =
            pickOldestCandidate(stallCandidates) ?? pickSlowestCandidate(relativeCandidates);
        if (!pick) {
            return;
        }

        pick.entry.abortReason = "slow-chunk";
        pick.entry.detect = pick.detect;
        pick.entry.chunkSpeedBps = pick.speed ?? 0;
        pick.entry.peerMedianBps = pick.peerMedianBps;
        pick.entry.attemptController.abort();
    }

    private peerMedianBps(
        scored: Array<{ entry: InFlightChunkTransfer; speed: number | null }>,
        candidate: InFlightChunkTransfer,
    ) {
        const positiveSpeeds = (items: typeof scored) =>
            items
                .filter(
                    (item) =>
                        item.entry.key !== candidate.key && item.speed !== null && item.speed > 0,
                )
                .map((item) => item.speed as number);

        const sameFilePeers = positiveSpeeds(
            scored.filter((item) => item.entry.fileId === candidate.fileId),
        );
        if (sameFilePeers.length >= SLOW_CHUNK_MIN_PEERS) {
            return median(sameFilePeers);
        }

        const globalPeers = positiveSpeeds(scored);
        if (globalPeers.length < SLOW_CHUNK_MIN_PEERS) {
            return 0;
        }
        return median(globalPeers);
    }

    private async processChunk(session: FileDownloadSession, chunk: DownloadChunkRow) {
        const {
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
            this.wakeWaiters();
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
            const transfer = this.registerInFlightTransfer({
                fileId: file.id,
                chunkIndex: chunk.chunkIndex,
                chunkSize: chunk.size,
                attemptController,
                slowReconnects,
            });

            try {
                if (controller.signal.aborted) {
                    onSessionAbort();
                } else {
                    controller.signal.addEventListener("abort", onSessionAbort);
                }

                const source =
                    mode === "byte-range" && range
                        ? this.deps.api.streamSegmentRange(
                              segment,
                              {
                                  localStart: range.localStart,
                                  localEnd: range.localEnd,
                              },
                              attemptController.signal,
                          )
                        : this.deps.api.streamSegment(segment, chunk, attemptController.signal);

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
                            this.recordInFlightTransferSample(transfer.key, transferredBytes);
                            this.deps.metrics.setChunkTransferProgress(
                                file.id,
                                chunk.chunkIndex,
                                scaleProgress(transferredBytes),
                            );
                        },
                        onWriteProgress: (writtenBytes) => {
                            this.deps.metrics.setChunkWriteProgress(
                                file.id,
                                chunk.chunkIndex,
                                scaleProgress(writtenBytes),
                            );
                        },
                    },
                );
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

                if (isAbortError(error) && abortReason !== "slow-chunk") {
                    this.deps.repository.markChunkPending(file.id, chunk.chunkIndex);
                    releaseInFlight();
                    return;
                }

                const message = toErrorMessage(error);
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
                this.unregisterInFlightTransfer(transfer.key);
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

type SlowAbortCandidate = {
    entry: InFlightChunkTransfer;
    speed: number | null;
    peerMedianBps: number;
    detect: SlowChunkDetect;
};

function pickOldestCandidate(candidates: SlowAbortCandidate[]) {
    let best: SlowAbortCandidate | null = null;
    for (const candidate of candidates) {
        if (!best || candidate.entry.startedAt < best.entry.startedAt) {
            best = candidate;
        }
    }
    return best;
}

function pickSlowestCandidate(candidates: SlowAbortCandidate[]) {
    let best: SlowAbortCandidate | null = null;
    for (const candidate of candidates) {
        if (!best) {
            best = candidate;
            continue;
        }
        const candidateSpeed = candidate.speed ?? Number.POSITIVE_INFINITY;
        const bestSpeed = best.speed ?? Number.POSITIVE_INFINITY;
        if (candidateSpeed < bestSpeed) {
            best = candidate;
        }
    }
    return best;
}

function compareWorkItems(left: SegmentWorkItem, right: SegmentWorkItem) {
    if (left.priority !== right.priority) {
        return left.priority - right.priority;
    }
    return left.order - right.order;
}
