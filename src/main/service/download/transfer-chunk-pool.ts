import { toErrorMessage } from "@shared/utils";

import type { KioskDownloader } from "../..";
import type { DownloadTransferMetrics } from "./metrics";
import type { PartFileWriter } from "./part-file";
import type { DownloadRepository } from "./repository";
import type { FileDownloadOutcome } from "./segment-pool";
import type { DownloadChunkRow, DownloadCollectionRow, DownloadFileRow } from "./types";

import { TransferRateLimitError } from "../transfer-request-pool";
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
    collectionId: string;
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
    onProgress: (collectionId: string, fileId: string) => void;
};

class TransferCdnUrlExpiredError extends Error {}

function compareWorkItems(a: TransferWorkItem, b: TransferWorkItem) {
    if (a.priority !== b.priority) {
        return a.priority - b.priority;
    }
    return a.order - b.order;
}

export class TransferChunkPool {
    private readonly sessions = new Map<string, TransferSession>();
    private readonly queue: TransferWorkItem[] = [];
    private nextOrder = 0;
    private targetWorkers = 0;
    private runningWorkers = 0;
    private lastClaimedCollectionId: string | null = null;
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

    public start(maxWorkers: number) {
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

    public register(registration: TransferFileRegistration) {
        if (registration.chunks.length === 0) {
            return Promise.resolve("completed" as const);
        }

        return new Promise<FileDownloadOutcome>((resolve) => {
            const session: TransferSession = {
                id: registration.file.id,
                collectionId: registration.collection.id,
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
            return;
        }
        if (session.aborted) {
            session.resolve("paused");
            return;
        }
        session.resolve("completed");
    }

    private async workerLoop() {
        try {
            while (true) {
                const claimed = this.compareAndClaimNext();
                if (!claimed) {
                    return;
                }

                const { item, session } = claimed;
                try {
                    if (session.aborted || session.registration.controller.signal.aborted) {
                        session.aborted = true;
                    } else if (!session.failed) {
                        const completed = await this.processChunk(session, item.chunk);
                        if (completed) {
                            session.remainingChunks = Math.max(0, session.remainingChunks - 1);
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
        } finally {
            this.runningWorkers -= 1;
            this.ensureWorkers();
        }
    }

    private async processChunk(
        session: TransferSession,
        chunk: DownloadChunkRow,
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
                        this.deps.onProgress(registration.collection.id, registration.file.id);
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
                            this.deps.onProgress(registration.collection.id, registration.file.id);
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

                if (abortReason === "slow-chunk") {
                    this.deps.kd.logger.warn(
                        {
                            channel: "transfer-download",
                            reason: "slow-chunk-exhausted",
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
                } else if (isAbortError(error)) {
                    this.deps.repository.markChunkPending(registration.file.id, chunk.chunkIndex);
                    throw error;
                }

                if (error instanceof TransferRateLimitError) {
                    const rateLimit = error.state;
                    this.deps.repository.markChunkPending(registration.file.id, chunk.chunkIndex);
                    this.deps.kd.logger.warn(
                        {
                            channel: "transfer-download",
                            reason: "provider-rate-limit",
                            fileId: registration.file.id,
                            chunkIndex: chunk.chunkIndex,
                            offset: chunk.offset,
                            expectedSize: chunk.size,
                            consecutiveRateLimits: rateLimit?.consecutiveRateLimits ?? 1,
                            cooldownMs: rateLimit?.cooldownMs ?? error.retryAfterMs ?? 0,
                            retryAfterMs: error.retryAfterMs,
                            coalesced: rateLimit ? !rateLimit.isNewEpisode : false,
                        },
                        "TransferChunkPool:rateLimited",
                    );
                    if (rateLimit?.terminal) {
                        this.deps.repository.markChunkError(chunk, TRANSFER_RATE_LIMIT_ERROR);
                        throw new Error(TRANSFER_RATE_LIMIT_ERROR);
                    }
                    await sleepWithAbort(
                        rateLimit?.cooldownMs ?? error.retryAfterMs ?? 0,
                        controller.signal,
                    );
                    needsMarkDownloading = true;
                    continue;
                }

                session.cdnUrl = null;
                const message =
                    abortReason === "slow-chunk"
                        ? "Slow chunk stalled after reconnects"
                        : toErrorMessage(error);
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
                if (abortReason === "slow-chunk" || !(error instanceof Error)) {
                    throw new Error(message);
                }
                throw error;
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
        let result: Awaited<ReturnType<TransferItApiClient["getDownloadUrl"]>>;
        try {
            result = await this.deps.api.getDownloadUrl(collection.shareId, file.remoteId, authPw);
        } catch (error) {
            if (error instanceof TransferRateLimitError) {
                this.deps.kd.service.transfer.requestPool.reportRateLimit(
                    {
                        collectionId: session.collectionId,
                        direction: "download",
                        providerId: "transfer-it-download",
                        signal,
                    },
                    error,
                );
            }
            throw error;
        }
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
        const deps = this.deps;
        const nodeKey = session.registration.nodeKey;

        for (let requestAttempt = 0; requestAttempt < 2; requestAttempt += 1) {
            try {
                yield* deps.kd.service.transfer.requestPool.runPayloadStream(
                    {
                        collectionId: session.collectionId,
                        direction: "download",
                        providerId: "transfer-it-download",
                        signal,
                    },
                    async function* () {
                        const response = await deps.kd.http.payloadRequest(url, {
                            method: "GET",
                            headers: { Range: range },
                            signal,
                            timeout: false,
                        });
                        if (response.status === 403 || response.status === 404) {
                            await response.body?.cancel().catch(() => undefined);
                            throw new TransferCdnUrlExpiredError();
                        }
                        if (response.status === 509) {
                            await response.body?.cancel().catch(() => undefined);
                            throw new TransferRateLimitError(
                                parseTransferRetryAfterMs(response.headers.get("retry-after")),
                            );
                        }
                        if (response.status !== 206 && response.status !== 200) {
                            await response.body?.cancel().catch(() => undefined);
                            throw new Error(`Transfer CDN HTTP ${response.status}.`);
                        }
                        if (!response.body) {
                            throw new Error("Transfer CDN response has no body.");
                        }

                        const contentRange = response.headers.get("content-range");
                        if (
                            response.status === 206 &&
                            !contentRange?.startsWith(`bytes ${requestStart}-`)
                        ) {
                            await response.body.cancel().catch(() => undefined);
                            throw new Error(
                                `Transfer CDN returned invalid Content-Range for ${range}.`,
                            );
                        }

                        const reader = response.body.getReader();
                        let transferred = 0;
                        let skipped = 0;
                        const skip = response.status === 200 ? requestStart : 0;
                        const expected = chunk.size - alreadyWritten;

                        try {
                            while (true) {
                                if (signal.aborted) {
                                    throw new DOMException(
                                        "The operation was aborted.",
                                        "AbortError",
                                    );
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
                                await deps.kd.service.transfer.downloadBandwidth.take(
                                    value.length,
                                    signal,
                                );
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
                                    nodeKey,
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
                    },
                );
                return;
            } catch (error) {
                if (!(error instanceof TransferCdnUrlExpiredError) || requestAttempt > 0) {
                    throw error;
                }
                session.cdnUrl = null;
                url = await this.ensureCdnUrl(session, signal);
            }
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
