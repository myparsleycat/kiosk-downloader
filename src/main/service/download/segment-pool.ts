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

export class GlobalSegmentPool {
    private targetWorkers = 0;
    private runningWorkers = 0;
    private nextOrder = 0;
    private readonly queue: SegmentWorkItem[] = [];
    private readonly sessions = new Map<string, FileDownloadSession>();
    private readonly waiters: Array<() => void> = [];

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

    private shouldWorkerContinue() {
        return this.runningWorkers <= this.targetWorkers;
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

    private async processChunk(session: FileDownloadSession, chunk: DownloadChunkRow) {
        const { file, segments, partWriter, controller, maxChunkRetries, streamWriteBatchBytes } =
            session.registration;
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

        const segment = segments[chunk.chunkIndex];
        if (!segment) {
            this.failSession(session, `Missing segment ${chunk.chunkIndex}.`, controller);
            releaseInFlight();
            return;
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (session.failed || session.aborted || controller.signal.aborted) {
                this.deps.repository.markChunkPending(file.id, chunk.chunkIndex);
                releaseInFlight();
                return;
            }

            this.deps.repository.markChunkDownloading(chunk);
            try {
                const bytes = await partWriter.writeChunkFromStream(
                    chunk.offset,
                    chunk.chunkIndex,
                    this.deps.api.streamSegment(segment, chunk, controller.signal),
                    chunk.size,
                    streamWriteBatchBytes,
                    {
                        onTransferProgress: (transferredBytes) => {
                            this.deps.metrics.setChunkTransferProgress(
                                file.id,
                                chunk.chunkIndex,
                                transferredBytes,
                            );
                        },
                        onWriteProgress: (writtenBytes) => {
                            this.deps.metrics.setChunkWriteProgress(
                                file.id,
                                chunk.chunkIndex,
                                writtenBytes,
                            );
                        },
                    },
                );
                this.deps.repository.markChunkCompleted(chunk, bytes);
                this.deps.repository.addFileDownloadedBytes(file.id, bytes);
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
                this.deps.metrics.clearChunk(file.id, chunk.chunkIndex);
                if (isAbortError(error) || controller.signal.aborted || session.aborted) {
                    this.deps.repository.markChunkPending(file.id, chunk.chunkIndex);
                    releaseInFlight();
                    return;
                }

                const message = toErrorMessage(error);
                if (attempt < maxAttempts) {
                    this.deps.kd.logger.warn(
                        {
                            channel: "segment-download",
                            fileId: file.id,
                            chunkIndex: chunk.chunkIndex,
                            offset: chunk.offset,
                            expectedSize: chunk.size,
                            segmentType: segment.type,
                            attempt,
                            maxRetries: maxChunkRetries,
                            message,
                        },
                        "DownloadService:streamSegment",
                    );
                    this.deps.repository.markChunkPending(file.id, chunk.chunkIndex);
                    try {
                        await sleepWithAbort(chunkBackoffMs(attempt), controller.signal);
                    } catch (abortError) {
                        if (isAbortError(abortError) || controller.signal.aborted) {
                            releaseInFlight();
                            return;
                        }
                        throw abortError;
                    }
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
                        attempt,
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
