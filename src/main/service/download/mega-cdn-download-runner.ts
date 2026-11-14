import type { TransferProviderRequestId } from "@shared/settings";
import type { DownloadProvider } from "@shared/types";
import fse from "fs-extra";

import type { KioskDownloader } from "../..";
import type { DownloadRepository } from "./repository";
import type { TransferItApiClient } from "./transfer-it-api-client";
import type { DownloadChunkRow, DownloadCollectionRow, DownloadFileRow } from "./types";

import { formatHttpError, snapshotFailedResponse } from "../../lib/http-error";
import { MegaQuotaExceededError, parseMegaTimeLeftMs, parseRetryAfterMs } from "../mega/mega-api";
import { MegaMacMismatchError, verifyMegaFileMac } from "../mega/mega-crypto";
import { TransferRateLimitError } from "../transfer-request-pool";
import { PartFileWriter } from "./part-file";
import {
    type ChunkRangeSource,
    parseTransferNodeKey,
    readRangeBody,
    type TransferChunkPool,
} from "./transfer-chunk-pool";
import { decryptTransferChunk } from "./transfer-it-crypto";

/** Provider-specific part of a download from a MEGA CDN (transfer.it or mega.nz). */
export type MegaCdnSpec = {
    provider: DownloadProvider;
    providerId: TransferProviderRequestId;
    cohortKey: string;
    label: string;
    rateLimitMessage?: string;
    resolveDownloadUrl: (signal: AbortSignal) => Promise<string>;
    /** Changes when previously resolved CDN URLs must not be reused (e.g. after a login change). */
    generation?: () => number;
    isFatal?: (error: unknown) => boolean;
    /**
     * Set for providers whose CDN 509 means an exhausted transfer quota rather than throttling.
     * Called synchronously when a range fails with that quota error.
     */
    onQuotaExceeded?: (error: MegaQuotaExceededError) => void;
};

export type MegaCdnSpecFactory = {
    create: (collection: DownloadCollectionRow, file: DownloadFileRow) => MegaCdnSpec;
    clearCollection?: (collectionId: string) => void;
    clear?: () => void;
};

type MegaCdnDownloadRunnerDeps = {
    kd: KioskDownloader;
    specs: MegaCdnSpecFactory;
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

export type MegaCdnDownloadRunInput = {
    collection: DownloadCollectionRow;
    file: DownloadFileRow;
    controller: AbortController;
    maxChunkRetries: number;
    priority: number;
    startedAt: number;
    collectionStartedAt: number;
};

export class MegaCdnDownloadRunner {
    public constructor(private readonly deps: MegaCdnDownloadRunnerDeps) {}

    public clearCollection(collectionId: string) {
        this.deps.specs.clearCollection?.(collectionId);
    }

    public destroy() {
        this.deps.specs.clear?.();
    }

    public async runFile(input: MegaCdnDownloadRunInput) {
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
        const nodeKey = parseTransferNodeKey(file.sourceMetaJson);

        const refreshedChunks = this.deps.repository.listChunks(file.id);
        if (file.size === 0 || areChunksComplete(refreshedChunks)) {
            await this.verifyAndFinalize(collection, file, nodeKey, input.controller.signal);
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
                    collection,
                    nodeKey,
                    spec: this.deps.specs.create(collection, file),
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
        } finally {
            await partWriter.close();
        }
        if (areChunksComplete(this.deps.repository.listChunks(file.id))) {
            await this.verifyAndFinalize(collection, file, nodeKey, input.controller.signal);
        }
    }

    private async verifyAndFinalize(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        nodeKey: Buffer,
        signal: AbortSignal,
    ) {
        if (file.size > 0) {
            const partPath = this.deps.getPartPath(collection, file);
            try {
                await verifyMegaFileMac(partPath, nodeKey, signal);
            } catch (error) {
                if (error instanceof MegaMacMismatchError) {
                    // The data is corrupt; keeping completed chunks would only reproduce it.
                    await fse.remove(partPath).catch(() => undefined);
                    await PartFileWriter.removeSidecar(partPath);
                    this.deps.repository.resetFileProgress(file.id);
                }
                throw error;
            }
        }
        await this.deps.finalizeFile(collection, file);
    }
}

class MegaCdnUrlExpiredError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "MegaCdnUrlExpiredError";
    }
}

export function createTransferItSpecFactory(
    api: Pick<TransferItApiClient, "getDownloadUrl" | "deriveAuthPw">,
) {
    const collectionAuth = new Map<string, string | undefined>();
    const getAuth = (collection: DownloadCollectionRow) => {
        if (!collectionAuth.has(collection.id)) {
            collectionAuth.set(collection.id, api.deriveAuthPw(collection));
        }
        return collectionAuth.get(collection.id);
    };
    return {
        create: (collection, file) => transferItCdnSpec(api, collection, file, getAuth(collection)),
        clearCollection: (collectionId) => collectionAuth.delete(collectionId),
        clear: () => collectionAuth.clear(),
    } satisfies MegaCdnSpecFactory;
}

export function transferItCdnSpec(
    api: Pick<TransferItApiClient, "getDownloadUrl">,
    collection: DownloadCollectionRow,
    file: DownloadFileRow,
    authPw?: string,
): MegaCdnSpec {
    return {
        provider: "transfer",
        providerId: "transfer-it-download",
        cohortKey: "transfer-cdn",
        label: "Transfer CDN",
        resolveDownloadUrl: async (signal) =>
            (await api.getDownloadUrl(collection.shareId, file.remoteId, authPw, signal)).url,
    };
}

export function createTransferRangeSource(input: {
    kd: KioskDownloader;
    collection: DownloadCollectionRow;
    nodeKey: Buffer;
    spec: MegaCdnSpec;
}): ChunkRangeSource {
    const kd = input.kd;
    const spec = input.spec;
    const requestContext = (signal: AbortSignal) => ({
        collectionId: input.collection.id,
        direction: "download" as const,
        providerId: spec.providerId,
        signal,
    });
    let cdnUrl: { url: string; generation: number | undefined } | null = null;

    const ensureCdnUrl = async (signal: AbortSignal) => {
        const generation = spec.generation?.();
        if (cdnUrl && cdnUrl.generation === generation) {
            return cdnUrl.url;
        }
        if (signal.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }
        let url: string;
        try {
            url = await spec.resolveDownloadUrl(signal);
        } catch (error) {
            if (error instanceof TransferRateLimitError) {
                kd.service.transfer.requestPool.reportRateLimit(requestContext(signal), error);
            }
            throw error;
        }
        signal.throwIfAborted();
        cdnUrl = { url, generation };
        return url;
    };

    const streamRange = async function* (
        ...[chunk, alreadyWritten, signal, onTransferProgress, onPhaseChange]: Parameters<
            ChunkRangeSource["openRange"]
        >
    ) {
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
                            throw new MegaCdnUrlExpiredError(
                                formatHttpError(
                                    spec.label,
                                    await snapshotFailedResponse(response, { signal }),
                                ),
                            );
                        }
                        if (response.status === 509) {
                            const retryAfterMs = parseRetryAfterMs(
                                response.headers.get("retry-after"),
                            );
                            await response.body?.cancel().catch(() => undefined);
                            if (spec.onQuotaExceeded) {
                                throw new MegaQuotaExceededError(
                                    parseMegaTimeLeftMs(response.headers) ?? retryAfterMs,
                                );
                            }
                            throw new TransferRateLimitError(retryAfterMs, spec.rateLimitMessage);
                        }
                        if (response.status !== 206 && response.status !== 200) {
                            throw new Error(
                                formatHttpError(
                                    spec.label,
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
                                `${spec.label} returned invalid Content-Range for ${range}.`,
                            );
                        }

                        let position = requestStart;
                        for await (const encrypted of readRangeBody(response, {
                            requestStart,
                            skip: response.status === 200 ? requestStart : 0,
                            expected: chunk.size - alreadyWritten,
                            label: spec.label,
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
                if (!(error instanceof MegaCdnUrlExpiredError) || requestAttempt > 0) {
                    throw error;
                }
                cdnUrl = null;
                onPhaseChange("control-wait");
                url = await ensureCdnUrl(signal);
            }
        }
    };

    return {
        provider: spec.provider,
        providerId: spec.providerId,
        cohortKey: spec.cohortKey,
        isFatal: spec.isFatal,
        invalidate: () => {
            cdnUrl = null;
        },
        async *openRange(chunk, alreadyWritten, signal, onTransferProgress, onPhaseChange) {
            try {
                yield* streamRange(
                    chunk,
                    alreadyWritten,
                    signal,
                    onTransferProgress,
                    onPhaseChange,
                );
            } catch (error) {
                // Reported before rethrowing so the pause aborts this chunk and it is kept as
                // pending instead of being retried against an exhausted quota.
                if (error instanceof MegaQuotaExceededError) {
                    spec.onQuotaExceeded?.(error);
                }
                throw error;
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
