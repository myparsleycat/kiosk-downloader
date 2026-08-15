import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import fse from "fs-extra";

import type { TransferRequestContext } from "../transfer-request-pool";
import type { DownloadTransferMetrics } from "./metrics";
import type { DownloadRepository } from "./repository";

import { PartFileWriter } from "./part-file";
import { sleepWithAbort } from "./slow-chunk-monitor";
import {
    parseWorkuploadFileSourceMeta,
    type DownloadCollectionRow,
    type DownloadFileRow,
} from "./types";
import {
    WorkuploadHttpError,
    type WorkuploadApiClient,
    type WorkuploadSession,
} from "./workupload-api-client";

export type WorkuploadStage =
    | "metadata"
    | "state"
    | "session"
    | "cdn-request"
    | "cdn-response"
    | "write"
    | "checksum"
    | "finalize";

export type WorkuploadCleanupState = "not-attempted" | "reset" | "preserved";

export type WorkuploadLogContext = {
    stage: WorkuploadStage;
    retryCount: number;
    rangeSupported: boolean | null;
    cleanupState: WorkuploadCleanupState;
};

type WorkuploadDownloadRunnerDeps = {
    api: WorkuploadApiClient;
    repository: DownloadRepository;
    metrics: DownloadTransferMetrics;
    runControl: <T>(task: () => Promise<T>) => Promise<T>;
    runPayload: <T>(context: TransferRequestContext, task: () => Promise<T>) => Promise<T>;
    takeBandwidth: (bytes: number, signal: AbortSignal) => Promise<void>;
    emitUpdate: (collectionId: string) => Promise<void>;
    markProgress: (collectionId: string, fileId: string) => void;
    getPartPath: (collection: DownloadCollectionRow, file: DownloadFileRow) => string;
    finalizeFile: (
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        signal?: AbortSignal,
    ) => Promise<void>;
};

export type WorkuploadDownloadRunInput = {
    collection: DownloadCollectionRow;
    file: DownloadFileRow;
    controller: AbortController;
    maxChunkRetries: number;
    streamWriteBatchBytes: number;
    logContext: WorkuploadLogContext;
};

const BODY_STALL_TIMEOUT_MS = 15_000;
const TRAILING_READ_TIMEOUT_MS = 2_000;
const PARTIAL_PERSIST_INTERVAL_MS = 1000;

class WorkuploadResponseError extends Error {
    public constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
        this.name = "WorkuploadResponseError";
    }
}

class WorkuploadChecksumError extends Error {
    public constructor(expected: string, actual: string) {
        super(`Workupload SHA-256 mismatch: expected ${expected}, got ${actual}.`);
        this.name = "WorkuploadChecksumError";
    }
}

class WorkuploadBodyStallError extends Error {
    public constructor() {
        super("Workupload CDN body stalled.");
        this.name = "WorkuploadBodyStallError";
    }
}

export function createWorkuploadLogContext(): WorkuploadLogContext {
    return {
        stage: "metadata",
        retryCount: 0,
        rangeSupported: null,
        cleanupState: "not-attempted",
    };
}

export class WorkuploadDownloadRunner {
    private readonly sessions = new Map<string, WorkuploadSession>();

    public constructor(private readonly deps: WorkuploadDownloadRunnerDeps) {}

    public clearCollection(collectionId: string) {
        this.sessions.delete(collectionId);
    }

    public destroy() {
        this.sessions.clear();
    }

    public async runFile(input: WorkuploadDownloadRunInput) {
        const { collection, file, controller, logContext } = input;
        logContext.stage = "metadata";
        const sourceMeta = parseWorkuploadFileSourceMeta(file.sourceMetaJson);
        logContext.rangeSupported = sourceMeta.rangeSupported ?? null;
        const partPath = this.deps.getPartPath(collection, file);

        if (file.size === 0) {
            logContext.stage = "checksum";
            const actual = createHash("sha256").update("").digest("hex");
            if (actual !== sourceMeta.sha256) {
                throw new WorkuploadChecksumError(sourceMeta.sha256, actual);
            }
            logContext.stage = "finalize";
            await this.deps.finalizeFile(collection, file, controller.signal);
            return;
        }

        let rangeSupported = sourceMeta.rangeSupported;
        let failures = 0;

        while (true) {
            logContext.stage = "state";
            logContext.cleanupState = "not-attempted";
            if (controller.signal.aborted) {
                await this.settleStopped(collection, file, rangeSupported, controller, logContext);
                return;
            }

            let chunk = this.deps.repository.listChunks(file.id)[0];
            if (!chunk) {
                throw new Error("Missing Workupload chunk descriptor.");
            }
            let resumeOffset = Math.min(file.size, Math.max(0, chunk.downloadedBytes));
            if (rangeSupported === false && resumeOffset > 0) {
                await this.resetPartial(collection, file, logContext);
                chunk = this.deps.repository.listChunks(file.id)[0];
                if (!chunk) {
                    throw new Error("Missing Workupload chunk descriptor after reset.");
                }
                resumeOffset = 0;
            }
            if (resumeOffset > 0) {
                const partSize = await fse
                    .stat(partPath)
                    .then((stat) => stat.size)
                    .catch(() => -1);
                if (partSize < resumeOffset || partSize > file.size) {
                    await this.resetPartial(collection, file, logContext);
                    continue;
                }
            }
            if (resumeOffset === file.size) {
                logContext.stage = "checksum";
                const actualSha256 = await sha256File(partPath, controller.signal);
                if (actualSha256 !== sourceMeta.sha256) {
                    await this.resetPartial(collection, file, logContext);
                    continue;
                }
                if (
                    await this.settleStopped(
                        collection,
                        file,
                        rangeSupported,
                        controller,
                        logContext,
                    )
                ) {
                    return;
                }
                this.deps.repository.markChunkCompleted(chunk, file.size);
                this.deps.repository.syncFileDownloadedBytes(file.id);
                logContext.stage = "finalize";
                await this.deps.finalizeFile(collection, file, controller.signal);
                return;
            }

            const partWriter = new PartFileWriter(partPath);
            this.deps.repository.markChunkDownloading(chunk);
            this.deps.metrics.registerFile(collection.id, file.id, resumeOffset);
            let writtenBytes = resumeOffset;
            let lastPartialPersistAt = 0;

            try {
                logContext.stage = "session";
                const { session, downloadUrl } = await this.deps.runControl(async () => {
                    throwIfAborted(controller.signal);
                    const session = await this.getSession(
                        collection,
                        file.remoteId,
                        controller.signal,
                    );
                    return {
                        session,
                        downloadUrl: await session.resolveDownloadUrl(file.remoteId),
                    };
                });
                logContext.stage = "cdn-request";
                const payloadResult = await this.deps.runPayload(
                    {
                        collectionId: collection.id,
                        direction: "download",
                        providerId: "workupload-download",
                        signal: controller.signal,
                    },
                    async () => {
                        const download = await session.requestResolvedDownload(
                            file.remoteId,
                            downloadUrl,
                            {
                                start: resumeOffset,
                                end: file.size - 1,
                                signal: controller.signal,
                            },
                        );
                        const { response } = download;
                        logContext.stage = "cdn-response";
                        const detectedRange = await this.requireDownloadResponse(
                            response,
                            resumeOffset,
                            file.size,
                        );
                        rangeSupported = detectedRange;
                        logContext.rangeSupported = detectedRange;
                        this.deps.repository.updateWorkuploadRangeSupported(file.id, detectedRange);
                        await this.deps.emitUpdate(collection.id);

                        if (!detectedRange && resumeOffset > 0) {
                            await response.body?.cancel().catch(() => undefined);
                            return { restart: true as const, bytes: 0 };
                        }
                        if (!response.body) {
                            throw new Error("Workupload CDN response has no body.");
                        }

                        logContext.stage = "write";
                        await partWriter.open(file.size, 1);
                        const bytes = await partWriter.writeChunkFromStream(
                            0,
                            0,
                            this.streamBody(
                                response.body,
                                controller.signal,
                                file.size - resumeOffset,
                                download.abort,
                            ),
                            file.size,
                            input.streamWriteBatchBytes,
                            {
                                onTransferProgress: (transferredBytes) => {
                                    this.deps.metrics.setChunkTransferProgress(
                                        file.id,
                                        0,
                                        transferredBytes,
                                    );
                                    this.deps.markProgress(collection.id, file.id);
                                },
                                onWriteProgress: (nextWrittenBytes) => {
                                    writtenBytes = nextWrittenBytes;
                                    const now = Date.now();
                                    if (now - lastPartialPersistAt >= PARTIAL_PERSIST_INTERVAL_MS) {
                                        this.deps.repository.markChunkPartial(
                                            file.id,
                                            0,
                                            writtenBytes,
                                        );
                                        lastPartialPersistAt = now;
                                    }
                                    this.deps.metrics.setChunkWriteProgress(
                                        file.id,
                                        0,
                                        writtenBytes - resumeOffset,
                                    );
                                    this.deps.markProgress(collection.id, file.id);
                                },
                            },
                            { alreadyWritten: resumeOffset },
                        );
                        return { restart: false as const, bytes };
                    },
                );
                await partWriter.close();
                if (payloadResult.restart) {
                    await this.resetPartial(collection, file, logContext);
                    continue;
                }
                if (
                    await this.settleStopped(
                        collection,
                        file,
                        rangeSupported,
                        controller,
                        logContext,
                        writtenBytes,
                    )
                ) {
                    return;
                }
                this.deps.repository.markChunkCompleted(chunk, payloadResult.bytes);
                this.deps.repository.syncFileDownloadedBytes(file.id);
                this.deps.metrics.clearChunk(file.id, 0, file.size);

                logContext.stage = "checksum";
                const actualSha256 = await sha256File(partPath, controller.signal);
                if (actualSha256 !== sourceMeta.sha256) {
                    await this.resetPartial(collection, file, logContext);
                    throw new WorkuploadChecksumError(sourceMeta.sha256, actualSha256);
                }
                if (
                    await this.settleStopped(
                        collection,
                        file,
                        rangeSupported,
                        controller,
                        logContext,
                        writtenBytes,
                    )
                ) {
                    return;
                }

                logContext.stage = "finalize";
                await this.deps.finalizeFile(collection, file, controller.signal);
                return;
            } catch (error) {
                await partWriter.close();
                if (isAbortError(error) || controller.signal.aborted) {
                    await this.settleStopped(
                        collection,
                        file,
                        rangeSupported,
                        controller,
                        logContext,
                        writtenBytes,
                    );
                    return;
                }
                if (!isRetryableError(error) || failures >= input.maxChunkRetries) {
                    if (rangeSupported === false) {
                        await this.resetPartial(collection, file, logContext);
                    } else if (logContext.cleanupState === "not-attempted") {
                        logContext.cleanupState = "preserved";
                    }
                    throw error;
                }

                failures += 1;
                logContext.retryCount = failures;
                this.sessions.delete(collection.id);
                if (rangeSupported !== true) {
                    await this.resetPartial(collection, file, logContext);
                } else {
                    this.persistPartial(file.id, writtenBytes, logContext);
                }
                await sleepWithAbort(Math.min(4000, 250 * 2 ** (failures - 1)), controller.signal);
            }
        }
    }

    public async getSession(
        collection: DownloadCollectionRow,
        fileKey: string,
        signal?: AbortSignal,
    ) {
        const cached = this.sessions.get(collection.id);
        if (cached) {
            return cached;
        }
        const session = await this.deps.api.createSession(collection.sourceUrl, {
            requestedFileKey: fileKey,
            password: collection.passwordPlain ?? undefined,
            signal,
        });
        this.sessions.set(collection.id, session);
        return session;
    }

    public async *streamBody(
        body: ReadableStream<Uint8Array>,
        signal: AbortSignal,
        expectedBytes: number,
        abortRequest?: () => void,
    ): AsyncGenerator<Uint8Array> {
        const reader = body.getReader();
        let receivedBytes = 0;
        try {
            while (true) {
                if (signal.aborted) {
                    throw new DOMException("The operation was aborted.", "AbortError");
                }
                const { done, value } = await readBodyChunk(reader, signal, abortRequest);
                if (done) {
                    if (receivedBytes !== expectedBytes) {
                        throw new Error(
                            `Workupload CDN returned ${receivedBytes}B, expected ${expectedBytes}B.`,
                        );
                    }
                    return;
                }
                if (!value || value.length === 0) {
                    continue;
                }
                receivedBytes += value.length;
                if (receivedBytes > expectedBytes) {
                    throw new Error(
                        `Workupload CDN returned more than the expected ${expectedBytes}B.`,
                    );
                }
                await this.deps.takeBandwidth(value.length, signal);
                yield value;
                if (receivedBytes !== expectedBytes) {
                    continue;
                }
                let trailing: ReadableStreamReadResult<Uint8Array>;
                try {
                    trailing = await readBodyChunk(
                        reader,
                        signal,
                        abortRequest,
                        TRAILING_READ_TIMEOUT_MS,
                    );
                } catch (error) {
                    if (error instanceof WorkuploadBodyStallError) {
                        return;
                    }
                    throw error;
                }
                while (!trailing.done && (!trailing.value || trailing.value.length === 0)) {
                    try {
                        trailing = await readBodyChunk(
                            reader,
                            signal,
                            abortRequest,
                            TRAILING_READ_TIMEOUT_MS,
                        );
                    } catch (error) {
                        if (error instanceof WorkuploadBodyStallError) {
                            return;
                        }
                        throw error;
                    }
                }
                if (!trailing.done) {
                    throw new Error(
                        `Workupload CDN returned more than the expected ${expectedBytes}B.`,
                    );
                }
            }
        } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    }

    public persistPartial(fileId: string, writtenBytes: number, logContext?: WorkuploadLogContext) {
        if (logContext) {
            logContext.cleanupState = "preserved";
        }
        this.deps.repository.markChunkPartial(fileId, 0, writtenBytes);
        this.deps.repository.markChunkPending(fileId, 0);
        this.deps.repository.syncWorkuploadDownloadedBytes(fileId);
    }

    private async requireDownloadResponse(response: Response, start: number, fileSize: number) {
        if (response.status !== 200 && response.status !== 206) {
            await response.body?.cancel().catch(() => undefined);
            throw new WorkuploadResponseError(
                `Workupload CDN HTTP ${response.status}.`,
                response.status,
            );
        }

        const expectedLength = response.status === 206 ? fileSize - start : fileSize;
        const contentLength = response.headers.get("content-length");
        if (contentLength !== null && Number(contentLength) !== expectedLength) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(
                `Workupload CDN returned invalid Content-Length for ${expectedLength} bytes.`,
            );
        }
        if (response.status === 200) {
            return false;
        }

        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            response.headers.get("content-range") ?? "",
        );
        if (
            !match ||
            Number(match[1]) !== start ||
            Number(match[2]) !== fileSize - 1 ||
            Number(match[3]) !== fileSize
        ) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error("Workupload CDN returned an invalid Content-Range.");
        }
        return true;
    }

    private async resetPartial(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        logContext: WorkuploadLogContext,
    ) {
        const partPath = this.deps.getPartPath(collection, file);
        await fse.remove(partPath).catch(() => undefined);
        await PartFileWriter.removeSidecar(partPath);
        logContext.cleanupState = "reset";
        this.deps.repository.resetFileProgress(file.id);
        this.deps.metrics.clearFile(file.id);
        this.deps.markProgress(collection.id, file.id);
        await this.deps.emitUpdate(collection.id);
    }

    private async settleStopped(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        rangeSupported: boolean | undefined,
        controller: AbortController,
        logContext: WorkuploadLogContext,
        writtenBytes?: number,
    ) {
        const current = this.deps.repository.getFile(file.id);
        if (!controller.signal.aborted && current?.status !== "paused") {
            return false;
        }
        if (rangeSupported === true) {
            this.persistPartial(
                file.id,
                writtenBytes ?? current?.downloadedBytes ?? file.downloadedBytes,
                logContext,
            );
            await this.deps.emitUpdate(collection.id);
        } else {
            await this.resetPartial(collection, file, logContext);
        }
        if (isActiveFileDownloadStatus(current?.status)) {
            this.deps.repository.markFileStatus(file.id, "pending");
        }
        return true;
    }
}

function readBodyChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
    abortRequest?: () => void,
    timeoutMs = BODY_STALL_TIMEOUT_MS,
) {
    return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            signal.removeEventListener("abort", onAbort);
        };
        const settle = (finish: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            finish();
        };
        const onAbort = () => {
            settle(() => reject(new DOMException("The operation was aborted.", "AbortError")));
        };

        timer = setTimeout(() => {
            settle(() => reject(new WorkuploadBodyStallError()));
            abortRequest?.();
        }, timeoutMs);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        try {
            void reader.read().then(
                (result) => settle(() => resolve(result)),
                (error) => settle(() => reject(error)),
            );
        } catch (error) {
            settle(() => reject(error));
        }
    });
}

async function sha256File(filePath: string, signal: AbortSignal) {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    try {
        for await (const chunk of stream) {
            if (signal.aborted) {
                throw new DOMException("The operation was aborted.", "AbortError");
            }
            hash.update(chunk);
        }
    } finally {
        stream.destroy();
    }
    return hash.digest("hex");
}

function isRetryableError(error: unknown) {
    if (error instanceof WorkuploadChecksumError) {
        return false;
    }
    if (error instanceof WorkuploadResponseError || error instanceof WorkuploadHttpError) {
        return (
            error.status === 302 ||
            error.status === 401 ||
            error.status === 403 ||
            error.status === 408 ||
            error.status === 429 ||
            error.status >= 500
        );
    }
    return true;
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
}

function isActiveFileDownloadStatus(status: DownloadFileRow["status"] | undefined) {
    return status === "downloading" || status === "inflating";
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
    }
}
