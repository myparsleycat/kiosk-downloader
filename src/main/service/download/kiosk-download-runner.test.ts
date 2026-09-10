import { afterEach, describe, expect, it, vi } from "vitest";

import type { DownloadChunkRow } from "./types";

import { CborHttpError } from "../../lib/http-error";
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

    it("retries with a refreshed token after a 401 from getSegments", async () => {
        const { input, runner, api, repository } = createRunner();
        const unauthorized = new CborHttpError(
            'file/gets failed: HTTP 401: {"code":"auth:invalid_token","message":"token expired"}',
            401,
        );
        api.getSegments
            .mockRejectedValueOnce(unauthorized)
            .mockResolvedValueOnce([{ type: "cdn" }, { type: "cdn" }]);
        api.refreshCollectionToken
            .mockResolvedValueOnce({ cat: "fresh-token", expires: 123 })
            .mockResolvedValueOnce({ cat: "second-token", expires: 456 });

        const segments = await runner.getFileSegments(
            input.collection,
            input.file,
            input.controller.signal,
        );

        expect(segments).toEqual([{ type: "cdn" }, { type: "cdn" }]);
        expect(api.refreshCollectionToken).toHaveBeenCalledTimes(2);
        expect(api.getSegments).toHaveBeenCalledTimes(2);
        expect(api.getSegments).toHaveBeenLastCalledWith(
            input.file.remoteId,
            "second-token",
            input.controller.signal,
        );
        expect(repository.updateCollectionFreshMeta).toHaveBeenCalledTimes(2);
    });

    it("fails without looping when the refreshed token is rejected again", async () => {
        const { input, runner, api } = createRunner();
        const unauthorized = new CborHttpError("file/gets failed: HTTP 401: token expired", 401);
        api.getSegments.mockRejectedValue(unauthorized);

        await expect(
            runner.getFileSegments(input.collection, input.file, input.controller.signal),
        ).rejects.toBe(unauthorized);
        expect(api.getSegments).toHaveBeenCalledTimes(2);
    });

    it("does not retry getSegments for non-401 failures", async () => {
        const { input, runner, api } = createRunner();
        const failure = new CborHttpError(
            'file/gets failed: HTTP 403: {"code":"collection:not_found"}',
            403,
        );
        api.getSegments.mockRejectedValueOnce(failure);

        await expect(
            runner.getFileSegments(input.collection, input.file, input.controller.signal),
        ).rejects.toBe(failure);
        expect(api.getSegments).toHaveBeenCalledTimes(1);
        expect(api.refreshCollectionToken).toHaveBeenCalledTimes(1);
    });

    it("shares a single refresh across concurrent 401 recoveries", async () => {
        const { input, runner, api, repository } = createRunner();
        api.refreshCollectionToken
            .mockResolvedValueOnce({ cat: "fresh-token", expires: 1 })
            .mockResolvedValueOnce({ cat: "second-token", expires: 2 });
        const firstFailure = Promise.withResolvers<never>();
        const secondFailure = Promise.withResolvers<never>();
        const unauthorized = new CborHttpError("file/gets failed: HTTP 401: token expired", 401);
        api.getSegments
            .mockImplementationOnce(() => firstFailure.promise)
            .mockImplementationOnce(() => secondFailure.promise);

        const fileB = { ...input.file, id: "file-b", remoteId: "remote-b" };
        const first = runner.getFileSegments(input.collection, input.file, input.controller.signal);
        const second = runner.getFileSegments(input.collection, fileB, input.controller.signal);
        await vi.waitFor(() => expect(api.getSegments).toHaveBeenCalledTimes(2));
        firstFailure.reject(unauthorized);
        secondFailure.reject(unauthorized);

        const [segmentsA, segmentsB] = await Promise.all([first, second]);
        expect(segmentsA).toEqual([{ type: "cdn" }, { type: "cdn" }]);
        expect(segmentsB).toEqual([{ type: "cdn" }, { type: "cdn" }]);
        expect(api.refreshCollectionToken).toHaveBeenCalledTimes(2);
        expect(api.getSegments).toHaveBeenCalledTimes(4);
        expect(api.getSegments).toHaveBeenNthCalledWith(
            3,
            input.file.remoteId,
            "second-token",
            input.controller.signal,
        );
        expect(api.getSegments).toHaveBeenNthCalledWith(
            4,
            fileB.remoteId,
            "second-token",
            input.controller.signal,
        );
        expect(repository.updateCollectionFreshMeta).toHaveBeenCalledTimes(2);
    });

    it("refreshes an expired cached token when a later file starts", async () => {
        const { input, runner, api } = createRunner();
        await runner.getFileSegments(input.collection, input.file, input.controller.signal);
        api.getSegments.mockRejectedValueOnce(new CborHttpError("CAT expired", 401));
        api.refreshCollectionToken.mockResolvedValueOnce({ cat: "renewed-token", expires: 456 });

        const laterFile = { ...input.file, id: "later-file", remoteId: "later-remote" };
        await runner.getFileSegments(input.collection, laterFile, input.controller.signal);

        expect(api.refreshCollectionToken).toHaveBeenCalledTimes(2);
        expect(api.getSegments).toHaveBeenNthCalledWith(
            2,
            laterFile.remoteId,
            "fresh-token",
            input.controller.signal,
        );
        expect(api.getSegments).toHaveBeenLastCalledWith(
            laterFile.remoteId,
            "renewed-token",
            input.controller.signal,
        );
    });

    it("reuses the newer token when an old request returns 401 after refresh finishes", async () => {
        const { input, runner, api } = createRunner();
        const delayed = Promise.withResolvers<never>();
        api.getSegments
            .mockImplementationOnce(() => delayed.promise)
            .mockRejectedValueOnce(new CborHttpError("CAT expired", 401));
        api.refreshCollectionToken
            .mockResolvedValueOnce({ cat: "old-token", expires: 123 })
            .mockResolvedValueOnce({ cat: "renewed-token", expires: 456 });
        const first = runner.getFileSegments(input.collection, input.file, input.controller.signal);
        await vi.waitFor(() => expect(api.getSegments).toHaveBeenCalledOnce());
        await runner.getFileSegments(input.collection, input.file, input.controller.signal);
        delayed.reject(new CborHttpError("CAT expired", 401));
        await first;

        expect(api.refreshCollectionToken).toHaveBeenCalledTimes(2);
        expect(api.getSegments).toHaveBeenLastCalledWith(
            input.file.remoteId,
            "renewed-token",
            input.controller.signal,
        );
    });

    it("does not keep using a rejected token after its refresh fails", async () => {
        const { input, runner, api } = createRunner();
        await runner.getFileSegments(input.collection, input.file, input.controller.signal);
        const failure = new Error("refresh unavailable");
        api.getSegments.mockRejectedValueOnce(new CborHttpError("CAT expired", 401));
        api.refreshCollectionToken.mockRejectedValueOnce(failure);
        await expect(
            runner.getFileSegments(input.collection, input.file, input.controller.signal),
        ).rejects.toBe(failure);
        api.refreshCollectionToken.mockResolvedValueOnce({ cat: "renewed-token", expires: 456 });

        await runner.getFileSegments(input.collection, input.file, input.controller.signal);

        expect(api.refreshCollectionToken).toHaveBeenCalledTimes(3);
        expect(api.getSegments).toHaveBeenLastCalledWith(
            input.file.remoteId,
            "renewed-token",
            input.controller.signal,
        );
    });

    it("refreshes again for an active file when the shared refresh's owner is paused", async () => {
        const { input, runner, api, repository } = createRunner();
        const refresh = Promise.withResolvers<{ cat: string; expires: number }>();
        api.refreshCollectionToken.mockImplementationOnce(() => refresh.promise);
        const first = runner.getFileSegments(input.collection, input.file, input.controller.signal);
        const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
        const siblingController = new AbortController();
        const sibling = runner.getFileSegments(
            input.collection,
            input.file,
            siblingController.signal,
        );
        input.controller.abort();
        refresh.reject(new DOMException("Paused", "AbortError"));

        await rejected;
        await expect(sibling).resolves.toEqual([{ type: "cdn" }, { type: "cdn" }]);
        expect(api.refreshCollectionToken).toHaveBeenCalledTimes(2);
        expect(api.refreshCollectionToken).toHaveBeenLastCalledWith(
            input.collection,
            siblingController.signal,
        );
        expect(repository.updateCollectionFreshMeta).toHaveBeenCalledOnce();
    });

    it.each([false, true])(
        "rejects segment results returned after cancellation (retry: %s)",
        async (retry) => {
            const { input, runner, api } = createRunner();
            if (retry) api.getSegments.mockRejectedValueOnce(new CborHttpError("CAT expired", 401));
            api.getSegments.mockImplementationOnce(async () => {
                input.controller.abort();
                return [{ type: "cdn" }];
            });

            await expect(
                runner.getFileSegments(input.collection, input.file, input.controller.signal),
            ).rejects.toMatchObject({ name: "AbortError" });
            expect(api.getSegments).toHaveBeenCalledTimes(retry ? 2 : 1);
        },
    );

    it("does not begin another refresh for a request cancelled with a 401 response", async () => {
        const { input, runner, api } = createRunner();
        api.getSegments.mockImplementationOnce(async () => {
            input.controller.abort();
            throw new CborHttpError("CAT expired", 401);
        });

        await expect(
            runner.getFileSegments(input.collection, input.file, input.controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(api.refreshCollectionToken).toHaveBeenCalledOnce();
    });

    it("cancels a waiting file without waiting for or cancelling another file's refresh", async () => {
        const { input, runner, api } = createRunner();
        const refresh = Promise.withResolvers<{ cat: string; expires: number }>();
        api.refreshCollectionToken.mockImplementationOnce(() => refresh.promise);
        const first = runner.getFileSegments(input.collection, input.file, input.controller.signal);
        const siblingController = new AbortController();
        const sibling = runner.getFileSegments(
            input.collection,
            input.file,
            siblingController.signal,
        );
        const rejected = expect(sibling).rejects.toMatchObject({ name: "AbortError" });
        siblingController.abort();

        try {
            await rejected;
            expect(input.controller.signal.aborted).toBe(false);
            expect(api.getSegments).not.toHaveBeenCalled();
        } finally {
            refresh.resolve({ cat: "fresh-token", expires: 123 });
            await first;
        }
        expect(api.refreshCollectionToken).toHaveBeenCalledOnce();
        expect(api.getSegments).toHaveBeenCalledOnce();
    });

    it.each(["clearCollection", "destroy"] as const)(
        "does not restore cleared tokens when an old refresh finishes after %s",
        async (operation) => {
            const { input, runner, api, repository } = createRunner();
            const refresh = Promise.withResolvers<{ cat: string; expires: number }>();
            api.refreshCollectionToken.mockImplementationOnce(() => refresh.promise);
            const first = runner.getFileSegments(
                input.collection,
                input.file,
                input.controller.signal,
            );
            const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
            if (operation === "clearCollection") runner.clearCollection(input.collection.id);
            else runner.destroy();

            await runner.getFileSegments(input.collection, input.file, input.controller.signal);
            refresh.resolve({ cat: "cleared-token", expires: 321 });
            await rejected;
            await runner.getFileSegments(input.collection, input.file, input.controller.signal);

            expect(api.refreshCollectionToken).toHaveBeenCalledTimes(2);
            expect(repository.updateCollectionFreshMeta).toHaveBeenCalledOnce();
            expect(api.getSegments).toHaveBeenLastCalledWith(
                input.file.remoteId,
                "fresh-token",
                input.controller.signal,
            );
        },
    );

    it("refreshes collection tokens independently in a combined download", async () => {
        const { input, runner, api } = createRunner();
        const otherCollection = { ...input.collection, id: "other-collection" };
        api.refreshCollectionToken
            .mockResolvedValueOnce({ cat: "collection-a-token", expires: 123 })
            .mockResolvedValueOnce({ cat: "collection-b-token", expires: 123 })
            .mockResolvedValueOnce({ cat: "collection-a-renewed", expires: 456 });
        await runner.getFileSegments(input.collection, input.file, input.controller.signal);
        await runner.getFileSegments(otherCollection, input.file, input.controller.signal);
        api.getSegments.mockRejectedValueOnce(new CborHttpError("CAT expired", 401));
        await runner.getFileSegments(input.collection, input.file, input.controller.signal);
        await runner.getFileSegments(otherCollection, input.file, input.controller.signal);

        expect(api.refreshCollectionToken).toHaveBeenCalledTimes(3);
        expect(api.refreshCollectionToken).toHaveBeenLastCalledWith(
            input.collection,
            input.controller.signal,
        );
        expect(api.getSegments).toHaveBeenLastCalledWith(
            input.file.remoteId,
            "collection-b-token",
            input.controller.signal,
        );
    });
});
