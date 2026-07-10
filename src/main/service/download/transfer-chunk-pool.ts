import { toErrorMessage } from "@shared/utils";

import type { KioskDownloader } from "../..";
import type { DownloadTransferMetrics } from "./metrics";
import type { PartFileWriter } from "./part-file";
import type { DownloadRepository } from "./repository";
import type { FileDownloadOutcome } from "./segment-pool";
import type { DownloadChunkRow, DownloadCollectionRow, DownloadFileRow } from "./types";

import {
    SLOW_CHUNK_MAX_RECONNECTS,
    SLOW_CHUNK_THRESHOLD_RATIO,
    SlowChunkMonitor,
    isAbortError,
    sleepWithAbort,
    slowReconnectDelayMs,
} from "./slow-chunk-monitor";
import {
    TRANSFER_RATE_LIMIT_ERROR,
    TransferRateLimitError,
    parseTransferRetryAfterMs,
    type TransferItApiClient,
} from "./transfer-it-api-client";
import { base64urlDecode, decryptTransferChunk } from "./transfer-it-crypto";

export type TransferFileRegistration = {
    collection: DownloadCollectionRow;
    file: DownloadFileRow;
    nodeKey: Buffer;
    authPw?: string;
    partWriter: PartFileWriter;
    controller: AbortController;
    maxChunkRetries: number;
    priority: number;
    chunks: DownloadChunkRow[];
    startedAt: number;
    collectionStartedAt: number;
};

type TransferWorkItem = {
    priority: number;
    order: number;
    sessionId: string;
    chunk: DownloadChunkRow;
};

type TransferSession = {
    id: string;
    registration: TransferFileRegistration;
    remainingChunks: number;
    inFlightChunks: number;
    failed: boolean;
    aborted: boolean;
    cdnUrl: string | null;
    resolve: (outcome: FileDownloadOutcome) => void;
};

type TransferPoolDeps = {
    kd: KioskDownloader;
    api: TransferItApiClient;
    repository: DownloadRepository;
    metrics: DownloadTransferMetrics;
    onChunkSettled: () => void;
};

function compareWorkItems(a: TransferWorkItem, b: TransferWorkItem) {
    if (a.priority !== b.priority) {
        return a.priority - b.priority;
    }
    return a.order - b.order;
}

export class TransferChunkPool {
    private static readonly MAX_WORKERS = 4;
    private static readonly SUCCESSES_PER_INCREASE = 8;
    private static readonly RATE_LIMIT_DELAYS_MS = [2000, 5000, 10000] as const;

    private readonly sessions = new Map<string, TransferSession>();
    private readonly queue: TransferWorkItem[] = [];
    private nextOrder = 0;
    private targetWorkers = 1;
    private runningWorkers = 0;
    private successesAtCurrentConcurrency = 0;
    private consecutiveRateLimits = 0;
    private cooldownUntil = 0;
    private cooldownWakeTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly waiters: Array<() => void> = [];
    private readonly slowChunkMonitor = new SlowChunkMonitor();

    public constructor(private readonly deps: TransferPoolDeps) {}

    public getOutstandingChunks(fileId: string) {
        const session = this.sessions.get(fileId);
        if (!session) {
            return null;
        }
        return session.remainingChunks;
    }

    public getTotalInFlight() {
        let total = 0;
        for (const session of this.sessions.values()) {
            total += session.inFlightChunks;
        }
        return total;
    }

    public hasSession(fileId: string) {
        return this.sessions.has(fileId);
    }

    public start() {
        this.ensureWorkers();
    }

    private ensureWorkers() {
        while (this.runningWorkers < this.targetWorkers) {
            this.runningWorkers += 1;
            void this.workerLoop(this.runningWorkers);
        }
        this.wakeWaiters();
    }

    public register(registration: TransferFileRegistration) {
        if (registration.chunks.length === 0) {
            return Promise.resolve("completed" as const);
        }

        return new Promise<FileDownloadOutcome>((resolve) => {
            const session: TransferSession = {
                id: registration.file.id,
                registration,
                remainingChunks: registration.chunks.length,
                inFlightChunks: 0,
                failed: false,
                aborted: false,
                cdnUrl: null,
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
        if (this.queue.length === 0 || Date.now() < this.cooldownUntil) {
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

    private tryCompleteSession(session: TransferSession) {
        if (session.inFlightChunks > 0) {
            return;
        }
        if (!session.aborted && !session.failed && session.remainingChunks > 0) {
            return;
        }

        this.sessions.delete(session.id);
        if (session.failed) {
            session.resolve("failed");
            if (this.sessions.size === 0) {
                this.consecutiveRateLimits = 0;
                this.cooldownUntil = 0;
                if (this.cooldownWakeTimer) {
                    clearTimeout(this.cooldownWakeTimer);
                    this.cooldownWakeTimer = null;
                }
            }
            return;
        }
        if (session.aborted) {
            session.resolve("paused");
            return;
        }
        session.resolve("completed");
    }

    private wakeWaiters() {
        const waiters = this.waiters.splice(0, this.waiters.length);
        for (const wake of waiters) {
            wake();
        }
    }

    private waitForWork() {
        return new Promise<void>((resolve) => {
            this.waiters.push(resolve);
        });
    }

    private async workerLoop(workerId: number) {
        while (workerId <= this.targetWorkers) {
            const claimed = this.compareAndClaimNext();
            if (!claimed) {
                await this.waitForWork();
                continue;
            }

            const { item, session } = claimed;
            try {
                if (session.aborted || session.registration.controller.signal.aborted) {
                    session.aborted = true;
                } else if (!session.failed) {
                    const completed = await this.processChunk(session, item.chunk, workerId);
                    if (completed) {
                        session.remainingChunks = Math.max(0, session.remainingChunks - 1);
                        this.recordChunkSuccess();
                    }
                }
            } catch (error) {
                if (session.failed) {
                    // Another in-flight chunk already failed this session.
                } else if (
                    isAbortError(error) ||
                    session.registration.controller.signal.aborted ||
                    session.aborted
                ) {
                    session.aborted = true;
                } else {
                    session.failed = true;
                    this.removeSessionItemsFromQueue(session.id);
                    const message = toErrorMessage(error);
                    this.deps.repository.markFileStatus(session.id, "error", message);
                    this.deps.kd.logger.error(
                        {
                            stage: "transfer-chunk",
                            fileId: session.id,
                            chunkIndex: item.chunk.chunkIndex,
                            message,
                        },
                        "TransferChunkPool:processChunk",
                    );
                }
            } finally {
                session.inFlightChunks = Math.max(0, session.inFlightChunks - 1);
                this.tryCompleteSession(session);
                this.deps.onChunkSettled();
            }
        }

        this.runningWorkers = Math.max(0, this.runningWorkers - 1);
        this.ensureWorkers();
    }

    private recordChunkSuccess() {
        this.consecutiveRateLimits = 0;
        if (
            Date.now() < this.cooldownUntil ||
            this.targetWorkers >= TransferChunkPool.MAX_WORKERS
        ) {
            return;
        }
        this.successesAtCurrentConcurrency += 1;
        if (this.successesAtCurrentConcurrency < TransferChunkPool.SUCCESSES_PER_INCREASE) {
            return;
        }
        this.successesAtCurrentConcurrency = 0;
        this.targetWorkers += 1;
        this.deps.kd.logger.info(
            {
                channel: "transfer-download",
                currentWorkers: this.targetWorkers,
                maxWorkers: TransferChunkPool.MAX_WORKERS,
            },
            "TransferChunkPool:increaseConcurrency",
        );
        this.ensureWorkers();
    }

    private registerRateLimit(error: TransferRateLimitError) {
        const now = Date.now();
        const isNewEpisode = now >= this.cooldownUntil;
        if (isNewEpisode) {
            this.consecutiveRateLimits += 1;
            this.targetWorkers = 1;
            this.successesAtCurrentConcurrency = 0;
            const delayMs = Math.max(
                TransferChunkPool.RATE_LIMIT_DELAYS_MS[
                    Math.min(
                        this.consecutiveRateLimits - 1,
                        TransferChunkPool.RATE_LIMIT_DELAYS_MS.length - 1,
                    )
                ],
                error.retryAfterMs ?? 0,
            );
            this.cooldownUntil = now + delayMs;
            if (this.cooldownWakeTimer) {
                clearTimeout(this.cooldownWakeTimer);
            }
            this.cooldownWakeTimer = setTimeout(() => {
                this.cooldownWakeTimer = null;
                this.wakeWaiters();
            }, delayMs);
        }
        return {
            consecutiveRateLimits: this.consecutiveRateLimits,
            cooldownMs: Math.max(0, this.cooldownUntil - now),
            isNewEpisode,
        };
    }

    private requeueChunk(session: TransferSession, chunk: DownloadChunkRow) {
        if (session.failed || session.aborted || session.registration.controller.signal.aborted) {
            return;
        }
        this.queue.push({
            priority: session.registration.priority,
            order: this.nextOrder,
            sessionId: session.id,
            chunk,
        });
        this.nextOrder += 1;
        this.queue.sort(compareWorkItems);
        this.wakeWaiters();
    }

    private async processChunk(
        session: TransferSession,
        chunk: DownloadChunkRow,
        workerId: number,
    ): Promise<boolean> {
        const { registration } = session;
        const controller = registration.controller;
        const maxAttempts = registration.maxChunkRetries + 1;

        let errorAttempt = 1;
        let slowReconnects = 0;
        let needsMarkDownloading = true;
        let committedBytes = Math.max(0, Math.min(chunk.size, chunk.downloadedBytes));

        while (errorAttempt <= maxAttempts) {
            if (session.failed || session.aborted || controller.signal.aborted) {
                this.deps.repository.markChunkPending(registration.file.id, chunk.chunkIndex);
                throw new DOMException("The operation was aborted.", "AbortError");
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
                fileId: registration.file.id,
                chunkIndex: chunk.chunkIndex,
                chunkSize: chunk.size,
                cohortKey: "transfer-cdn",
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

                const plain = this.streamDecryptedRange(
                    session,
                    chunk,
                    attemptController.signal,
                    resumeOffset,
                    (transferredBytes) => {
                        this.slowChunkMonitor.recordSample(
                            transfer.key,
                            resumeOffset + transferredBytes,
                        );
                        this.deps.metrics.setChunkTransferProgress(
                            registration.file.id,
                            chunk.chunkIndex,
                            resumeOffset + transferredBytes,
                        );
                    },
                    (phase) => this.slowChunkMonitor.setPhase(transfer.key, phase),
                );
                const bytes = await registration.partWriter.writeChunkFromStream(
                    chunk.offset,
                    chunk.chunkIndex,
                    plain,
                    chunk.size,
                    256 * 1024,
                    {
                        onWriteProgress: (writtenBytes) => {
                            committedBytes = writtenBytes;
                            this.deps.repository.markChunkPartial(
                                registration.file.id,
                                chunk.chunkIndex,
                                writtenBytes,
                            );
                            this.deps.metrics.setChunkWriteProgress(
                                registration.file.id,
                                chunk.chunkIndex,
                                writtenBytes,
                            );
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
                this.deps.repository.syncFileDownloadedBytes(registration.file.id);
                const updatedFile = this.deps.repository.getFile(registration.file.id);
                this.deps.metrics.clearChunk(
                    registration.file.id,
                    chunk.chunkIndex,
                    updatedFile?.downloadedBytes,
                );
                return true;
            } catch (error) {
                const abortReason = transfer.abortReason;
                const detect = transfer.detect;
                const chunkSpeedBps = transfer.chunkSpeedBps;
                const peerMedianBps = transfer.peerMedianBps;
                const transferredBytes = transfer.transferredBytes;
                this.deps.metrics.clearChunk(registration.file.id, chunk.chunkIndex);

                if (controller.signal.aborted || session.aborted) {
                    this.deps.repository.markChunkPending(registration.file.id, chunk.chunkIndex);
                    throw new DOMException("The operation was aborted.", "AbortError");
                }

                if (abortReason === "slow-chunk" && slowReconnects < SLOW_CHUNK_MAX_RECONNECTS) {
                    slowReconnects += 1;
                    this.deps.kd.logger.warn(
                        {
                            channel: "transfer-download",
                            reason: "slow-chunk-reconnect",
                            detect: detect ?? "relative",
                            fileId: registration.file.id,
                            chunkIndex: chunk.chunkIndex,
                            offset: chunk.offset,
                            expectedSize: chunk.size,
                            chunkSpeedBps,
                            peerMedianBps,
                            thresholdRatio: SLOW_CHUNK_THRESHOLD_RATIO,
                            slowReconnect: slowReconnects,
                            maxSlowReconnects: SLOW_CHUNK_MAX_RECONNECTS,
                            transferredBytes,
                        },
                        "TransferChunkPool:fetchEncryptedRange",
                    );
                    try {
                        await sleepWithAbort(slowReconnectDelayMs(), controller.signal);
                    } catch (abortError) {
                        if (isAbortError(abortError) || controller.signal.aborted) {
                            this.deps.repository.markChunkPending(
                                registration.file.id,
                                chunk.chunkIndex,
                            );
                            throw new DOMException("The operation was aborted.", "AbortError");
                        }
                        throw abortError;
                    }
                    continue;
                }

                if (isAbortError(error) && abortReason !== "slow-chunk") {
                    this.deps.repository.markChunkPending(registration.file.id, chunk.chunkIndex);
                    throw error;
                }

                if (error instanceof TransferRateLimitError) {
                    const rateLimit = this.registerRateLimit(error);
                    this.deps.repository.markChunkPending(registration.file.id, chunk.chunkIndex);
                    this.deps.kd.logger.warn(
                        {
                            channel: "transfer-download",
                            reason: "provider-rate-limit",
                            fileId: registration.file.id,
                            chunkIndex: chunk.chunkIndex,
                            offset: chunk.offset,
                            expectedSize: chunk.size,
                            currentWorkers: this.targetWorkers,
                            maxWorkers: TransferChunkPool.MAX_WORKERS,
                            consecutiveRateLimits: rateLimit.consecutiveRateLimits,
                            cooldownMs: rateLimit.cooldownMs,
                            retryAfterMs: error.retryAfterMs,
                            coalesced: !rateLimit.isNewEpisode,
                        },
                        "TransferChunkPool:rateLimited",
                    );
                    if (rateLimit.consecutiveRateLimits >= 3) {
                        this.deps.repository.markChunkError(chunk, TRANSFER_RATE_LIMIT_ERROR);
                        throw new Error(TRANSFER_RATE_LIMIT_ERROR);
                    }
                    await sleepWithAbort(rateLimit.cooldownMs, controller.signal);
                    if (workerId > this.targetWorkers) {
                        this.requeueChunk(session, chunk);
                        return false;
                    }
                    needsMarkDownloading = true;
                    continue;
                }

                session.cdnUrl = null;
                const message = toErrorMessage(error);
                if (errorAttempt < maxAttempts) {
                    this.deps.kd.logger.warn(
                        {
                            channel: "transfer-download",
                            fileId: registration.file.id,
                            chunkIndex: chunk.chunkIndex,
                            offset: chunk.offset,
                            expectedSize: chunk.size,
                            attempt: errorAttempt,
                            maxRetries: registration.maxChunkRetries,
                            message,
                        },
                        "TransferChunkPool:fetchEncryptedRange",
                    );
                    this.deps.repository.markChunkPending(registration.file.id, chunk.chunkIndex);
                    try {
                        await sleepWithAbort(1000 * errorAttempt, controller.signal);
                    } catch (abortError) {
                        if (isAbortError(abortError) || controller.signal.aborted) {
                            throw new DOMException("The operation was aborted.", "AbortError");
                        }
                        throw abortError;
                    }
                    errorAttempt += 1;
                    needsMarkDownloading = true;
                    continue;
                }

                this.deps.repository.markChunkError(chunk, message);
                throw error instanceof Error ? error : new Error(message);
            } finally {
                this.slowChunkMonitor.unregister(transfer.key);
                controller.signal.removeEventListener("abort", onSessionAbort);
            }
        }
        return false;
    }

    private async ensureCdnUrl(session: TransferSession, signal: AbortSignal) {
        if (session.cdnUrl) {
            return session.cdnUrl;
        }
        if (signal.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }
        const { collection, file, authPw } = session.registration;
        const result = await this.deps.api.getDownloadUrl(
            collection.shareId,
            file.remoteId,
            authPw,
        );
        session.cdnUrl = result.url;
        return result.url;
    }

    private async *streamDecryptedRange(
        session: TransferSession,
        chunk: DownloadChunkRow,
        signal: AbortSignal,
        alreadyWritten: number,
        onTransferProgress?: (transferredBytes: number) => void,
        onPhaseChange?: (phase: "network" | "bandwidth-wait") => void,
    ) {
        let url = await this.ensureCdnUrl(session, signal);
        const requestStart = chunk.offset + alreadyWritten;
        const range = `bytes=${requestStart}-${chunk.offset + chunk.size - 1}`;

        let response = await this.deps.kd.http.request(url, {
            method: "GET",
            headers: { Range: range },
            signal,
            timeout: false,
        });

        if (response.status === 403 || response.status === 404) {
            session.cdnUrl = null;
            url = await this.ensureCdnUrl(session, signal);
            response = await this.deps.kd.http.request(url, {
                method: "GET",
                headers: { Range: range },
                signal,
                timeout: false,
            });
        }

        if (response.status === 509) {
            await response.body?.cancel().catch(() => undefined);
            throw new TransferRateLimitError(
                parseTransferRetryAfterMs(response.headers.get("retry-after")),
            );
        }
        if (response.status !== 206 && response.status !== 200) {
            throw new Error(`Transfer CDN HTTP ${response.status}.`);
        }
        if (!response.body) {
            throw new Error("Transfer CDN response has no body.");
        }

        const contentRange = response.headers.get("content-range");
        if (response.status === 206 && !contentRange?.startsWith(`bytes ${requestStart}-`)) {
            await response.body.cancel().catch(() => undefined);
            throw new Error(`Transfer CDN returned invalid Content-Range for ${range}.`);
        }

        const reader = response.body.getReader();
        let transferred = 0;
        let skipped = 0;
        const skip = response.status === 200 ? requestStart : 0;
        const expected = chunk.size - alreadyWritten;

        try {
            while (true) {
                if (signal.aborted) {
                    throw new DOMException("The operation was aborted.", "AbortError");
                }

                onPhaseChange?.("network");
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                if (!value || value.length === 0) {
                    continue;
                }

                onPhaseChange?.("bandwidth-wait");
                await this.deps.kd.service.transfer.downloadBandwidth.take(value.length, signal);
                onPhaseChange?.("network");
                let encrypted = value;
                if (skipped < skip) {
                    const skipBytes = Math.min(encrypted.length, skip - skipped);
                    skipped += skipBytes;
                    encrypted = encrypted.subarray(skipBytes);
                }
                if (encrypted.length === 0) {
                    continue;
                }
                const remaining = expected - transferred;
                if (encrypted.length > remaining) {
                    encrypted = encrypted.subarray(0, remaining);
                }
                const plain = decryptTransferChunk(
                    session.registration.nodeKey,
                    requestStart + transferred,
                    Buffer.from(encrypted),
                );
                transferred += encrypted.length;
                onTransferProgress?.(transferred);
                yield plain;
                if (transferred >= expected) {
                    break;
                }
            }
        } catch (error) {
            try {
                await reader.cancel();
            } catch {
                // ignore cancel failures after abort/error
            }
            throw error;
        } finally {
            try {
                await reader.cancel();
            } catch {
                // response may already be closed
            }
            try {
                reader.releaseLock();
            } catch {
                // already released after cancel
            }
        }

        if (transferred !== expected) {
            throw new Error(
                `Transfer CDN returned ${transferred}B, expected ${expected}B for range ${range}.`,
            );
        }
    }
}

export function parseTransferNodeKey(sourceMetaJson: string | null) {
    if (!sourceMetaJson) {
        throw new Error("Missing transfer file crypto metadata.");
    }
    let parsed: { nodeKey?: string };
    try {
        parsed = JSON.parse(sourceMetaJson) as { nodeKey?: string };
    } catch {
        throw new Error("Invalid transfer file crypto metadata.");
    }
    if (typeof parsed.nodeKey !== "string" || !parsed.nodeKey) {
        throw new Error("Transfer file node key missing.");
    }
    const key = base64urlDecode(parsed.nodeKey);
    if (key.length !== 32) {
        throw new Error(`Invalid transfer file key length ${key.length} (expected 32).`);
    }
    return key;
}
