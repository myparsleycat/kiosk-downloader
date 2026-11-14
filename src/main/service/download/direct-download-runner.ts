import type { DirectRequestHeaders } from "@shared/types";
import { toErrorMessage } from "@shared/utils";
import fse from "fs-extra";
import type { LimitFunction } from "p-limit";

import type { KioskDownloader } from "../..";
import type { DownloadRepository } from "./repository";
import type { DownloadChunkRow, DownloadCollectionRow, DownloadFileRow } from "./types";

import { toLogUrl } from "../../lib/http";
import { TransferRateLimitError } from "../transfer-request-pool";
import {
    DirectHttpError,
    DirectRemoteChangedError,
    DirectWebPageError,
    directIfRangeValidator,
    directSegmentSize,
    hasDirectRemoteChanged,
    hasDirectValidatorChanged,
    isWebPageResponse,
    parseContentRangeTotal,
    toDirectSourceMeta,
    type DirectHttpClient,
} from "./direct-http-client";
import { PartFileWriter } from "./part-file";
import { isAbortError } from "./slow-chunk-monitor";
import {
    type ChunkRangeSource,
    readRangeBody,
    type TransferChunkPool,
} from "./transfer-chunk-pool";
import { parseDirectFileSourceMeta } from "./types";

const REMOTE_CHANGED_AGAIN_ERROR = "다운로드 중 원격 파일이 계속 변경되었습니다.";

type DirectDownloadRunnerDeps = {
    kd: KioskDownloader;
    api: DirectHttpClient;
    repository: DownloadRepository;
    transferPool: TransferChunkPool;
    runControl: LimitFunction;
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
    emitUpdate: (collectionId: string) => Promise<void>;
};

export type DirectDownloadRunInput = {
    collection: DownloadCollectionRow;
    file: DownloadFileRow;
    controller: AbortController;
    maxChunkRetries: number;
    priority: number;
    startedAt: number;
    collectionStartedAt: number;
};

type DirectRangeSource = ChunkRangeSource & { remoteChanged: boolean };

export class DirectDownloadRunner {
    public constructor(private readonly deps: DirectDownloadRunnerDeps) {}

    public clearCollection(_collectionId: string) {}

    public destroy() {}

    public async runFile(input: DirectDownloadRunInput) {
        const signal = input.controller.signal;
        if (
            input.file.size === 0 ||
            hasStoredProgress(this.deps.repository.listChunks(input.file.id))
        ) {
            await this.revalidateRemote(input.collection, input.file, signal);
        }

        for (let restart = 0; ; restart += 1) {
            const outcome = await this.runOnce(input);
            if (outcome !== "remote-changed") {
                return;
            }
            if (restart > 0) {
                throw new Error(REMOTE_CHANGED_AGAIN_ERROR);
            }
            const probe = await this.deps.runControl(() =>
                this.deps.api.probe(
                    input.collection.sourceUrl,
                    parseRequestHeaders(input.collection),
                    signal,
                ),
            );
            await this.resetToRemote(input.collection, input.file, probe);
        }
    }

    // Before resuming, re-probe so a file replaced while paused restarts instead of
    // splicing old and new bytes. On probe failure, only a validator permits resuming.
    private async revalidateRemote(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        signal: AbortSignal,
    ) {
        const probe = await this.deps
            .runControl(() =>
                this.deps.api.probe(collection.sourceUrl, parseRequestHeaders(collection), signal),
            )
            .catch((error: unknown) => {
                if (isAbortError(error) || signal.aborted || error instanceof DirectWebPageError) {
                    throw error;
                }
                this.deps.kd.logger.warn(
                    {
                        channel: "direct-download",
                        collectionId: collection.id,
                        fileId: file.id,
                        sourceUrl: toLogUrl(collection.sourceUrl),
                        message: toErrorMessage(error),
                    },
                    "DirectDownloadRunner:revalidateRemote",
                );
                return null;
            });
        const stored = parseDirectFileSourceMeta(file.sourceMetaJson);
        if (!probe) {
            if (!directIfRangeValidator(stored)) {
                await this.removePartFiles(collection, file);
                this.deps.repository.resetFileProgress(file.id);
            }
            return;
        }

        if (hasDirectRemoteChanged({ ...stored, size: file.size }, probe)) {
            this.deps.kd.logger.warn(
                {
                    channel: "direct-download",
                    collectionId: collection.id,
                    fileId: file.id,
                    sourceUrl: toLogUrl(collection.sourceUrl),
                    storedSize: file.size,
                    remoteSize: probe.size,
                    rangeSupported: probe.rangeSupported,
                },
                "DirectDownloadRunner:remoteChanged",
            );
            await this.resetToRemote(collection, file, probe);
            return;
        }
        // Signed redirect targets expire; keep the one this probe just resolved.
        if (probe.finalUrl !== stored.finalUrl) {
            this.deps.repository.updateDirectRemote(file.id, {
                size: file.size,
                segmentSize: directSegmentSize(probe),
                sourceMetaJson: JSON.stringify(toDirectSourceMeta(probe)),
            });
        }
    }

    private async runOnce(input: DirectDownloadRunInput) {
        const chunks = this.deps.repository.listChunks(input.file.id);
        await this.deps.validateCompletedChunks(input.collection, input.file, chunks);
        this.deps.repository.syncFileDownloadedBytes(input.file.id);

        const file = this.deps.repository.getFile(input.file.id);
        const collection = this.deps.repository.getCollection(input.collection.id);
        if (!file || !collection) {
            return "done" as const;
        }

        const refreshedChunks = this.deps.repository.listChunks(file.id);
        if (file.size === 0 || areChunksComplete(refreshedChunks)) {
            await this.deps.finalizeFile(collection, file);
            return "done" as const;
        }

        const partWriter = new PartFileWriter(this.deps.getPartPath(collection, file));
        const source = this.createRangeSource(collection, file);
        // The pool aborts the controller it is given when the file fails. Hand it a child so
        // the file's own signal stays usable for the re-probe after a remote change.
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(input.controller.signal.reason);
        if (input.controller.signal.aborted) {
            forwardAbort();
        }
        input.controller.signal.addEventListener("abort", forwardAbort, { once: true });
        try {
            await partWriter.open(file.size, refreshedChunks.length);
            const outcome = await this.deps.transferPool.register({
                collection,
                file,
                source,
                partWriter,
                controller,
                maxChunkRetries: input.maxChunkRetries,
                priority: input.priority,
                chunks: refreshedChunks.filter(
                    (chunk) => chunk.status === "pending" || chunk.status === "error",
                ),
                startedAt: input.startedAt,
                collectionStartedAt: input.collectionStartedAt,
            });

            if (outcome === "failed") {
                return source.remoteChanged ? ("remote-changed" as const) : ("done" as const);
            }
            if (outcome === "paused") {
                await partWriter.close();
                await this.settlePaused(collection, file);
                return "done" as const;
            }
            if (areChunksComplete(this.deps.repository.listChunks(file.id))) {
                await this.deps.finalizeFile(collection, file);
            }
            return "done" as const;
        } finally {
            input.controller.signal.removeEventListener("abort", forwardAbort);
            await partWriter.close();
        }
    }

    // Without Range support a partial file can never be resumed, so pausing is a stop.
    private async settlePaused(collection: DownloadCollectionRow, file: DownloadFileRow) {
        if (!parseDirectFileSourceMeta(file.sourceMetaJson).rangeSupported) {
            await this.removePartFiles(collection, file);
            this.deps.repository.resetFileProgress(file.id);
        }
        if (this.deps.repository.hasErroredChunk(file.id)) {
            return;
        }
        const currentFile = this.deps.repository.getFile(file.id);
        if (currentFile?.status === "downloading" || currentFile?.status === "inflating") {
            this.deps.repository.markFileStatus(file.id, "pending");
        }
        this.deps.markProgress(collection.id, file.id);
    }

    private async resetToRemote(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        probe: Awaited<ReturnType<DirectHttpClient["probe"]>>,
    ) {
        await this.removePartFiles(collection, file);
        this.deps.repository.resetFileProgress(file.id);
        this.deps.repository.updateDirectRemote(file.id, {
            size: probe.size,
            segmentSize: directSegmentSize(probe),
            sourceMetaJson: JSON.stringify(toDirectSourceMeta(probe)),
        });
        this.deps.repository.markFileStatus(file.id, "downloading");
        this.deps.markProgress(collection.id, file.id);
        await this.deps.emitUpdate(collection.id);
    }

    private async removePartFiles(collection: DownloadCollectionRow, file: DownloadFileRow) {
        const partPath = this.deps.getPartPath(collection, file);
        await fse.remove(partPath);
        await PartFileWriter.removeSidecar(partPath);
    }

    private createRangeSource(
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
    ): DirectRangeSource {
        const kd = this.deps.kd;
        const api = this.deps.api;
        const meta = parseDirectFileSourceMeta(file.sourceMetaJson);
        const headers = parseRequestHeaders(collection);
        const ifRange = meta.rangeSupported ? directIfRangeValidator(meta) : undefined;
        const requestContext = (signal: AbortSignal) => ({
            collectionId: collection.id,
            direction: "download" as const,
            providerId: "direct-download" as const,
            signal,
        });
        // Shared by concurrent chunk workers; each attempt keeps its own copy of the URL it used.
        let resolvedUrl = meta.finalUrl ?? collection.sourceUrl;

        const source: DirectRangeSource = {
            provider: "direct",
            providerId: "direct-download",
            cohortKey: `direct:${collection.shareId}`,
            remoteChanged: false,
            isFatal: (error) =>
                error instanceof DirectRemoteChangedError || error instanceof DirectWebPageError,
            async *openRange(chunk, alreadyWritten, signal, onTransferProgress, onPhaseChange) {
                const requestStart = chunk.offset + alreadyWritten;
                const range = meta.rangeSupported
                    ? `bytes=${requestStart}-${chunk.offset + chunk.size - 1}`
                    : undefined;

                let requestUrl = resolvedUrl;
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    try {
                        onPhaseChange("request-wait");
                        yield* kd.service.transfer.requestPool.runPayloadStream(
                            requestContext(signal),
                            async function* () {
                                onPhaseChange("network");
                                const opened = await openOrThrottle(api, requestUrl, {
                                    headers,
                                    cookieOriginUrl: collection.sourceUrl,
                                    range,
                                    ifRange,
                                    signal,
                                });
                                resolvedUrl = opened.url;
                                const response = opened.response;
                                try {
                                    assertSameRemote(response, meta, file.size, requestStart);
                                } catch (error) {
                                    if (error instanceof DirectRemoteChangedError) {
                                        source.remoteChanged = true;
                                    }
                                    await response.body?.cancel().catch(() => undefined);
                                    throw error;
                                }
                                yield* readRangeBody(response, {
                                    requestStart,
                                    skip: response.status === 200 ? requestStart : 0,
                                    expected: chunk.size - alreadyWritten,
                                    label: "직접 다운로드",
                                    signal,
                                    takeBandwidth: (bytes, takeSignal) =>
                                        kd.service.transfer.downloadBandwidth.take(
                                            bytes,
                                            takeSignal,
                                        ),
                                    onTransferProgress,
                                    onPhaseChange,
                                });
                            },
                        );
                        return;
                    } catch (error) {
                        // A cached signed/CDN URL may have expired; resolve once more from the
                        // original link before treating the status as a real failure.
                        const expired =
                            error instanceof DirectHttpError &&
                            [401, 403, 404, 410].includes(error.status) &&
                            requestUrl !== collection.sourceUrl;
                        if (!expired || attempt > 0) {
                            throw error;
                        }
                        requestUrl = collection.sourceUrl;
                    }
                }
            },
        };
        return source;
    }
}

async function openOrThrottle(
    api: DirectHttpClient,
    url: string,
    options: Parameters<DirectHttpClient["open"]>[1],
) {
    try {
        return await api.open(url, options);
    } catch (error) {
        if (error instanceof DirectHttpError && (error.status === 429 || error.status === 503)) {
            throw new TransferRateLimitError(
                error.retryAfterMs,
                "서버가 다운로드 요청을 제한했습니다. 잠시 후 다시 시도해 주세요.",
            );
        }
        throw error;
    }
}

// Servers may ignore If-Range, and a retry without Range re-reads from byte 0, so every
// response is checked against the stored size and validators before bytes are kept.
function assertSameRemote(
    response: Response,
    meta: ReturnType<typeof parseDirectFileSourceMeta>,
    size: number,
    requestStart: number,
) {
    if (!meta.rangeSupported) {
        if (response.status !== 200) {
            throw new Error(
                `직접 다운로드 서버가 예상하지 못한 상태(${response.status})를 보냈습니다.`,
            );
        }
        const length = Number(response.headers.get("content-length") ?? Number.NaN);
        if (Number.isSafeInteger(length) && length !== size) {
            throw new DirectRemoteChangedError();
        }
    } else {
        // A 200 to an If-Range request means the validator no longer matches.
        if (response.status !== 206) {
            throw new DirectRemoteChangedError();
        }
        const contentRange = response.headers.get("content-range");
        if (
            !contentRange?.startsWith(`bytes ${requestStart}-`) ||
            parseContentRangeTotal(contentRange) !== size
        ) {
            throw new DirectRemoteChangedError();
        }
    }
    if (isWebPageResponse(response)) {
        throw new DirectWebPageError();
    }
    const current = {
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
    };
    if (hasDirectValidatorChanged(meta, current)) {
        throw new DirectRemoteChangedError();
    }
}

function parseRequestHeaders(collection: DownloadCollectionRow) {
    return collection.requestHeadersJson
        ? (JSON.parse(collection.requestHeadersJson) as DirectRequestHeaders)
        : undefined;
}

function hasStoredProgress(chunks: DownloadChunkRow[]) {
    return chunks.some((chunk) => chunk.downloadedBytes > 0 || chunk.status === "completed");
}

function areChunksComplete(chunks: DownloadChunkRow[]) {
    return chunks.length > 0 && chunks.every((chunk) => chunk.status === "completed");
}
