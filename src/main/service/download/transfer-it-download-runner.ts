import fse from "fs-extra";

import type { KioskDownloader } from "../..";
import type { DownloadRepository } from "./repository";
import type { DownloadChunkRow, DownloadCollectionRow, DownloadFileRow } from "./types";

import { formatHttpError, snapshotFailedResponse } from "../../lib/http-error";
import { TransferRateLimitError } from "../transfer-request-pool";
import { PartFileWriter } from "./part-file";
import {
    type ChunkRangeSource,
    parseTransferNodeKey,
    readRangeBody,
    type TransferChunkPool,
} from "./transfer-chunk-pool";
import { parseTransferRetryAfterMs, type TransferItApiClient } from "./transfer-it-api-client";
import { decryptTransferChunk } from "./transfer-it-crypto";

type TransferItDownloadRunnerDeps = {
    kd: KioskDownloader;
    api: TransferItApiClient;
    repository: DownloadRepository;
    transferPool: TransferChunkPool;
    getPartPath: (collection: DownloadCollectionRow, file: DownloadFileRow) => string;
    validateCompletedChunks: (
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        chunks: DownloadChunkRow[],
    ) => Promise<void>;
    finalizeFile: (
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        signal?: AbortSignal,
    ) => Promise<void>;
    markProgress: (collectionId: string, fileId: string) => void;
};

export type TransferItDownloadRunInput = {
    collection: DownloadCollectionRow;
    file: DownloadFileRow;
    controller: AbortController;
    maxChunkRetries: number;
    priority: number;
    startedAt: number;
    collectionStartedAt: number;
};

export class TransferItDownloadRunner {
    private readonly collectionAuth = new Map<string, string | undefined>();

    public constructor(private readonly deps: TransferItDownloadRunnerDeps) {}

    public clearCollection(collectionId: string) {
        this.collectionAuth.delete(collectionId);
    }

    public destroy() {
        this.collectionAuth.clear();
    }

    public async runFile(input: TransferItDownloadRunInput) {
        const partPath = this.deps.getPartPath(input.collection, input.file);
        if (this.deps.repository.reconcileTransferChunkLayout(input.file.id)) {
            await fse.remove(partPath).catch(() => undefined);
            await PartFileWriter.removeSidecar(partPath);
        }

        const chunks = this.deps.repository.listChunks(input.file.id);
        await this.deps.validateCompletedChunks(input.collection, input.file, chunks);
        this.deps.repository.syncFileDownloadedBytes(input.file.id);

        const file = this.deps.repository.getFile(input.file.id);
        const collection = this.deps.repository.getCollection(input.collection.id);
        if (!file || !collection) {
            return;
        }

        const refreshedChunks = this.deps.repository.listChunks(file.id);
        if (file.size === 0 || areChunksComplete(refreshedChunks)) {
            await this.deps.finalizeFile(collection, file);
            return;
        }

        const partWriter = new PartFileWriter(this.deps.getPartPath(collection, file));

        try {
            await partWriter.open(file.size, refreshedChunks.length);
            const outcome = await this.deps.transferPool.register({
                collection,
                file,
                source: createTransferRangeSource({
                    kd: this.deps.kd,
                    api: this.deps.api,
                    collection,
                    file,
                    nodeKey: parseTransferNodeKey(file.sourceMetaJson),
                    authPw: this.getAuth(collection),
                }),
                partWriter,
                controller: input.controller,
                maxChunkRetries: input.maxChunkRetries,
                priority: input.priority,
                chunks: refreshedChunks.filter(
                    (chunk) => chunk.status === "pending" || chunk.status === "error",
                ),
                startedAt: input.startedAt,
                collectionStartedAt: input.collectionStartedAt,
            });

            if (outcome === "paused") {
                if (!this.deps.repository.hasErroredChunk(file.id)) {
                    const currentFile = this.deps.repository.getFile(file.id);
                    if (isActiveFileDownloadStatus(currentFile?.status)) {
                        this.deps.repository.markFileStatus(file.id, "pending");
                        this.deps.markProgress(collection.id, file.id);
                    }
                }
                return;
            }
            if (outcome === "failed") {
                return;
            }
            if (areChunksComplete(this.deps.repository.listChunks(file.id))) {
                await this.deps.finalizeFile(collection, file);
            }
        } finally {
            await partWriter.close();
        }
    }

    private getAuth(collection: DownloadCollectionRow) {
        if (this.collectionAuth.has(collection.id)) {
            return this.collectionAuth.get(collection.id);
        }
        const authPw = this.deps.api.deriveAuthPw(collection);
        this.collectionAuth.set(collection.id, authPw);
        return authPw;
    }
}

class TransferCdnUrlExpiredError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "TransferCdnUrlExpiredError";
    }
}

export function createTransferRangeSource(input: {
    kd: KioskDownloader;
    api: Pick<TransferItApiClient, "getDownloadUrl">;
    collection: DownloadCollectionRow;
    file: DownloadFileRow;
    nodeKey: Buffer;
    authPw?: string;
}): ChunkRangeSource {
    const kd = input.kd;
    const requestContext = (signal: AbortSignal) => ({
        collectionId: input.collection.id,
        direction: "download" as const,
        providerId: "transfer-it-download" as const,
        signal,
    });
    let cdnUrl: string | null = null;

    const ensureCdnUrl = async (signal: AbortSignal) => {
        if (cdnUrl) {
            return cdnUrl;
        }
        if (signal.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }
        let result: Awaited<ReturnType<TransferItApiClient["getDownloadUrl"]>>;
        try {
            result = await input.api.getDownloadUrl(
                input.collection.shareId,
                input.file.remoteId,
                input.authPw,
                signal,
            );
        } catch (error) {
            if (error instanceof TransferRateLimitError) {
                kd.service.transfer.requestPool.reportRateLimit(requestContext(signal), error);
            }
            throw error;
        }
        signal.throwIfAborted();
        cdnUrl = result.url;
        return result.url;
    };

    return {
        provider: "transfer",
        providerId: "transfer-it-download",
        cohortKey: "transfer-cdn",
        invalidate: () => {
            cdnUrl = null;
        },
        async *openRange(chunk, alreadyWritten, signal, onTransferProgress, onPhaseChange) {
            onPhaseChange("control-wait");
            let url = await ensureCdnUrl(signal);
            const requestStart = chunk.offset + alreadyWritten;
            const range = `bytes=${requestStart}-${chunk.offset + chunk.size - 1}`;

            for (let requestAttempt = 0; requestAttempt < 2; requestAttempt += 1) {
                try {
                    onPhaseChange("request-wait");
                    yield* kd.service.transfer.requestPool.runPayloadStream(
                        requestContext(signal),
                        async function* () {
                            onPhaseChange("network");
                            const response = await kd.http.payloadRequest(url, {
                                method: "GET",
                                headers: { Range: range },
                                signal,
                                timeout: false,
                            });
                            if (response.status === 403 || response.status === 404) {
                                throw new TransferCdnUrlExpiredError(
                                    formatHttpError(
                                        "Transfer CDN",
                                        await snapshotFailedResponse(response, { signal }),
                                    ),
                                );
                            }
                            if (response.status === 509) {
                                const retryAfterMs = parseTransferRetryAfterMs(
                                    response.headers.get("retry-after"),
                                );
                                await response.body?.cancel().catch(() => undefined);
                                throw new TransferRateLimitError(retryAfterMs);
                            }
                            if (response.status !== 206 && response.status !== 200) {
                                throw new Error(
                                    formatHttpError(
                                        "Transfer CDN",
                                        await snapshotFailedResponse(response, { signal }),
                                    ),
                                );
                            }
                            const contentRange = response.headers.get("content-range");
                            if (
                                response.status === 206 &&
                                !contentRange?.startsWith(`bytes ${requestStart}-`)
                            ) {
                                await response.body?.cancel().catch(() => undefined);
                                throw new Error(
                                    `Transfer CDN returned invalid Content-Range for ${range}.`,
                                );
                            }

                            let position = requestStart;
                            for await (const encrypted of readRangeBody(response, {
                                requestStart,
                                skip: response.status === 200 ? requestStart : 0,
                                expected: chunk.size - alreadyWritten,
                                label: "Transfer CDN",
                                signal,
                                takeBandwidth: (bytes, takeSignal) =>
                                    kd.service.transfer.downloadBandwidth.take(bytes, takeSignal),
                                onTransferProgress,
                                onPhaseChange,
                            })) {
                                const plain = decryptTransferChunk(
                                    input.nodeKey,
                                    position,
                                    Buffer.from(encrypted),
                                );
                                position += encrypted.length;
                                yield plain;
                            }
                        },
                    );
                    return;
                } catch (error) {
                    if (!(error instanceof TransferCdnUrlExpiredError) || requestAttempt > 0) {
                        throw error;
                    }
                    cdnUrl = null;
                    onPhaseChange("control-wait");
                    url = await ensureCdnUrl(signal);
                }
            }
        },
    };
}

function isActiveFileDownloadStatus(status: DownloadFileRow["status"] | undefined) {
    return status === "downloading" || status === "inflating";
}

function areChunksComplete(chunks: DownloadChunkRow[]) {
    return chunks.length > 0 && chunks.every((chunk) => chunk.status === "completed");
}
