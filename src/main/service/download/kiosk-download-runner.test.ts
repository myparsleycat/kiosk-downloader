import { afterEach, describe, expect, it, vi } from "vitest";

import type { DownloadChunkRow } from "./types";

import { KioskDownloadRunner, type KioskDownloadRunInput } from "./kiosk-download-runner";
import { PartFileWriter } from "./part-file";
import { GlobalSegmentPool } from "./segment-pool";

function createRunner() {
    const input = {
        collection: { id: "collection" },
        file: { id: "file", remoteId: "remote", size: 2, downloadedBytes: 0 },
        controller: new AbortController(),
        maxChunkRetries: 0,
        streamWriteBatchBytes: 1,
        priority: 0,
        startedAt: 0,
        collectionStartedAt: 0,
    } as KioskDownloadRunInput;
    const chunks = [0, 1].map(
        (chunkIndex) =>
            ({
                collectionId: "collection",
                fileId: "file",
                chunkIndex,
                offset: chunkIndex,
                size: 1,
                downloadedBytes: 0,
                attempts: 0,
                status: "pending",
                updatedAt: "",
                error: null,
            }) satisfies DownloadChunkRow,
    );
    const completed = new Set<number>();
    const repository = {
        listChunks: vi.fn(() =>
            chunks.map((chunk) => ({
                ...chunk,
                status: completed.has(chunk.chunkIndex) ? "completed" : "pending",
            })),
        ),
        getFile: vi.fn(() => input.file),
        getCollection: vi.fn(() => input.collection),
        syncFileDownloadedBytes: vi.fn(),
        updateCollectionFreshMeta: vi.fn(),
        markFileStatus: vi.fn(),
        markChunkDownloading: vi.fn(),
        markChunkPending: vi.fn(),
        markChunkError: vi.fn(),
        markChunkCompleted: vi.fn((chunk: DownloadChunkRow) => {
            completed.add(chunk.chunkIndex);
        }),
        addFileDownloadedBytes: vi.fn(),
    };
    const api = {
        refreshCollectionToken: vi.fn(async () => ({ cat: "fresh-token", expires: 123 })),
        getSegments: vi.fn(async () => [{ type: "cdn" }, { type: "cdn" }]),
        streamSegment: vi.fn(),
    };
    const pool = new GlobalSegmentPool({
        kd: { logger: { error: vi.fn(), warn: vi.fn() } },
        api,
        repository,
        metrics: { registerFile: vi.fn(), clearChunk: vi.fn() },
        onChunkSettled: vi.fn(),
        onProgress: vi.fn(),
    } as never);
    pool.resize(2);
    const finalizeFile = vi.fn(async () => undefined);
    const runner = new KioskDownloadRunner({
        api,
        repository,
        segmentPool: pool,
        runControl: async <T>(task: () => Promise<T>) => await task(),
        getPartPath: () => "/unused/file.part",
        validateCompletedChunks: vi.fn(async () => undefined),
        finalizeFile,
        markProgress: vi.fn(),
    } as never);
    return { input, repository, api, pool, runner, finalizeFile };
}

describe("KioskDownloadRunner recovery", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps the writer open until a failed download's sibling drains, then retries successfully", async () => {
        const { input, pool, runner, finalizeFile } = createRunner();
        vi.spyOn(PartFileWriter.prototype, "open").mockResolvedValue();
        const close = vi.spyOn(PartFileWriter.prototype, "close").mockResolvedValue();
        const failure = Promise.withResolvers<number>();
        const sibling = Promise.withResolvers<number>();
        const write = vi
            .spyOn(PartFileWriter.prototype, "writeChunkFromStream")
            .mockImplementationOnce(() => failure.promise)
            .mockImplementationOnce(() => sibling.promise);
        const first = runner.runFile(input);
        const settled = vi.fn();
        void first.then(settled);
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));

        failure.reject(new Error("network failure"));
        await vi.waitFor(() => expect(input.controller.signal.aborted).toBe(true));
        expect(close).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        expect(pool.getTotalInFlight()).toBe(1);

        sibling.reject(new DOMException("cancelled sibling", "AbortError"));
        await first;
        expect(close).toHaveBeenCalledTimes(1);
        expect(pool.getTotalInFlight()).toBe(0);
        expect(finalizeFile).not.toHaveBeenCalled();

        write.mockResolvedValue(1);
        await runner.runFile({ ...input, controller: new AbortController() });
        expect(write).toHaveBeenCalledTimes(4);
        expect(close).toHaveBeenCalledTimes(2);
        expect(finalizeFile).toHaveBeenCalledTimes(1);
        expect(pool.getOutstandingChunks(input.file.id)).toBeNull();
    });

    it("does not persist or cache a token returned after refresh cancellation", async () => {
        const { input, runner, api, repository } = createRunner();
        const refresh = Promise.withResolvers<{ cat: string; expires: number }>();
        api.refreshCollectionToken.mockImplementationOnce(() => refresh.promise);
        const first = runner.getFileSegments(input.collection, input.file, input.controller.signal);
        const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
        expect(api.refreshCollectionToken).toHaveBeenCalledWith(
            input.collection,
            input.controller.signal,
        );
        input.controller.abort();
        refresh.resolve({ cat: "cancelled-token", expires: 321 });
        await rejected;
        expect(repository.updateCollectionFreshMeta).not.toHaveBeenCalled();
        expect(api.getSegments).not.toHaveBeenCalled();

        const retryController = new AbortController();
        await runner.getFileSegments(input.collection, input.file, retryController.signal);
        expect(api.refreshCollectionToken).toHaveBeenCalledTimes(2);
        expect(repository.updateCollectionFreshMeta).toHaveBeenCalledOnce();
        expect(api.getSegments).toHaveBeenCalledWith(
            input.file.remoteId,
            "fresh-token",
            retryController.signal,
        );
    });
});
