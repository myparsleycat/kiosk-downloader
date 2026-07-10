import { toErrorMessage } from "@shared/utils";

import type { KioskDownloader } from "../..";
import type { DownloadTransferMetrics } from "./metrics";
import type { PartFileWriter } from "./part-file";
import type { DownloadRepository } from "./repository";
import type { FileDownloadOutcome } from "./segment-pool";
import type { TransferItApiClient } from "./transfer-it-api-client";
import type { DownloadChunkRow, DownloadCollectionRow, DownloadFileRow } from "./types";

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
    private readonly sessions = new Map<string, TransferSession>();
    private readonly queue: TransferWorkItem[] = [];
    private nextOrder = 0;
    private targetWorkers = 1;
    private runningWorkers = 0;
    private readonly waiters: Array<() => void> = [];

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

    public resize(maxWorkers: number) {
        this.targetWorkers = Math.max(1, Math.floor(maxWorkers));
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

    private tryCompleteSession(session: TransferSession) {
        if (session.inFlightChunks > 0) {
            return;
        }
        if (!session.aborted && !session.failed && session.remainingChunks > 0) {
            return;
        }

        this.sessions.delete(session.id);
        if (session.aborted) {
            session.resolve("paused");
            return;
        }
        if (session.failed) {
            session.resolve("failed");
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
                    await this.processChunk(session, item.chunk);
                    session.remainingChunks = Math.max(0, session.remainingChunks - 1);
                }
            } catch (error) {
                if (
                    (error instanceof DOMException && error.name === "AbortError") ||
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
    }

    private async processChunk(session: TransferSession, chunk: DownloadChunkRow) {
        const { registration } = session;
        const signal = registration.controller.signal;
        this.deps.repository.markChunkDownloading(chunk);

        let lastError: unknown;
        for (let attempt = 0; attempt <= registration.maxChunkRetries; attempt++) {
            if (signal.aborted || session.aborted) {
                throw new DOMException("The operation was aborted.", "AbortError");
            }

            try {
                const enc = await this.fetchEncryptedRange(session, chunk, signal);
                const plain = decryptTransferChunk(registration.nodeKey, chunk.offset, enc);
                if (plain.length !== chunk.size) {
                    throw new Error(
                        `Decrypted chunk size mismatch: got ${plain.length}, expected ${chunk.size}.`,
                    );
                }
                await registration.partWriter.writeAt(chunk.offset, plain, chunk.chunkIndex);
                this.deps.repository.markChunkCompleted(chunk, chunk.size);
                this.deps.repository.syncFileDownloadedBytes(registration.file.id);
                this.deps.metrics.setChunkTransferProgress(
                    registration.file.id,
                    chunk.chunkIndex,
                    chunk.size,
                );
                this.deps.metrics.setChunkWriteProgress(
                    registration.file.id,
                    chunk.chunkIndex,
                    chunk.size,
                );
                const updatedFile = this.deps.repository.getFile(registration.file.id);
                this.deps.metrics.clearChunk(
                    registration.file.id,
                    chunk.chunkIndex,
                    updatedFile?.downloadedBytes,
                );
                return;
            } catch (error) {
                lastError = error;
                if (
                    (error instanceof DOMException && error.name === "AbortError") ||
                    signal.aborted
                ) {
                    throw error;
                }
                session.cdnUrl = null;
                if (attempt === registration.maxChunkRetries) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }

        const message = toErrorMessage(lastError);
        this.deps.repository.markChunkError(chunk, message);
        throw lastError instanceof Error ? lastError : new Error(message);
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

    private async fetchEncryptedRange(
        session: TransferSession,
        chunk: DownloadChunkRow,
        signal: AbortSignal,
    ) {
        let url = await this.ensureCdnUrl(session, signal);
        const range = `bytes=${chunk.offset}-${chunk.offset + chunk.size - 1}`;

        let response = await this.deps.kd.http.request(url, {
            method: "GET",
            headers: { Range: range },
            signal,
        });

        if (response.status === 403 || response.status === 404) {
            session.cdnUrl = null;
            url = await this.ensureCdnUrl(session, signal);
            response = await this.deps.kd.http.request(url, {
                method: "GET",
                headers: { Range: range },
                signal,
            });
        }

        if (response.status === 509) {
            throw new Error("Transfer CDN bandwidth quota exceeded (HTTP 509).");
        }
        if (response.status !== 206 && response.status !== 200) {
            throw new Error(`Transfer CDN HTTP ${response.status}.`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        await this.deps.kd.service.transfer.downloadBandwidth.take(buffer.length, signal);

        if (buffer.length !== chunk.size) {
            throw new Error(
                `Transfer CDN returned ${buffer.length}B, expected ${chunk.size}B for range ${range}.`,
            );
        }
        return buffer;
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
