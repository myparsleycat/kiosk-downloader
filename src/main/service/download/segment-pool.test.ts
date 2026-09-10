import { afterEach, describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";

import { TransferScheduler } from "../transfer-request-pool";
import { KioApiClient } from "./kio-api-client";
import { GlobalSegmentPool, type FileDownloadRegistration } from "./segment-pool";

function createPool() {
    return new GlobalSegmentPool({
        metrics: { registerFile: vi.fn() },
        onChunkSettled: vi.fn(),
    } as never);
}

function registration(collectionId: string, fileId: string, chunkCount: number) {
    const controller = new AbortController();
    controller.abort();
    return {
        collection: { id: collectionId },
        file: { id: fileId, downloadedBytes: 0 },
        chunks: Array.from({ length: chunkCount }, (_, chunkIndex) => ({
            chunkIndex,
            downloadedBytes: 0,
            size: 1,
        })),
        controller,
        maxChunkRetries: 0,
        segments: [],
        priority: 0,
    } as never;
}

describe("GlobalSegmentPool", () => {
    it("submits queued collections in rotation without owning payload permits", () => {
        const pool = createPool();
        void pool.register(registration("collection-a", "file-a", 2));
        void pool.register(registration("collection-b", "file-b", 2));
        void pool.register(registration("collection-c", "file-c", 2));
        const claim = (pool as unknown as { compareAndClaimNext: () => never }).compareAndClaimNext;

        expect(
            Array.from(
                { length: 6 },
                () => claim.call(pool) as { session: { collectionId: string } },
            ).map((entry) => entry.session.collectionId),
        ).toEqual([
            "collection-a",
            "collection-b",
            "collection-c",
            "collection-a",
            "collection-b",
            "collection-c",
        ]);
    });

    it("caps started workers at the configured base plus one extra per extra collection", () => {
        const pool = createPool();
        pool.resize(2);
        for (const collectionId of ["a", "b", "c", "d"]) {
            void pool.register(registration(collectionId, `file-${collectionId}`, 4));
        }

        expect(pool.getRunningWorkers()).toBe(5);
        expect(pool.getTargetWorkers()).toBe(2);
    });

    it("does not grow workers for queued work that never registers sessions", () => {
        const pool = createPool();
        pool.resize(8);
        expect(pool.getRunningWorkers()).toBe(0);
        expect(pool.getTargetWorkers()).toBe(8);
    });

    it("removes every queued chunk when a session is cancelled before workers start", async () => {
        const pool = createPool();
        const outcome = pool.register(registration("collection", "file", 2));

        pool.cancelSession("file");

        await expect(outcome).resolves.toBe("paused");
        expect((pool as unknown as { queue: unknown[] }).queue).toHaveLength(0);
    });
});

function createRunningPool() {
    const requestPool = new TransferScheduler(2);
    const payloadRequest = vi.fn(async (_url: string) => new Response("x"));
    const repository = {
        markFileStatus: vi.fn(),
        markChunkDownloading: vi.fn(),
        markChunkPending: vi.fn(),
        markChunkPartial: vi.fn(),
        markChunkCompleted: vi.fn(),
        markChunkError: vi.fn(),
        addFileDownloadedBytes: vi.fn(),
        getFile: vi.fn(() => ({ downloadedBytes: 0 })),
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const kd = {
        http: { payloadRequest },
        logger,
        service: { transfer: { requestPool, downloadBandwidth: { take: vi.fn() } } },
    } as unknown as KioskDownloader;
    const onChunkSettled = vi.fn();
    const refreshSegments = vi.fn(async () =>
        [0, 1].map(() => ({
            type: "cdn" as const,
            data: new Map<string, unknown>([["url", "https://cdn.test/fresh"]]),
        })),
    );
    const pool = new GlobalSegmentPool({
        kd,
        api: new KioApiClient(kd),
        repository: repository as never,
        metrics: {
            registerFile: vi.fn(),
            setChunkTransferProgress: vi.fn(),
            setChunkWriteProgress: vi.fn(),
            clearChunk: vi.fn(),
        } as never,
        refreshSegments,
        onChunkSettled,
        onProgress: vi.fn(),
    });
    const partWriter = {
        writeChunkFromStream: vi.fn(
            async (_offset: number, _index: number, source: AsyncIterable<Uint8Array>) => {
                let bytes = 0;
                for await (const chunk of source) bytes += chunk.length;
                return bytes;
            },
        ),
    };
    const input = {
        collection: { id: "collection" },
        file: { id: "file", downloadedBytes: 0 },
        controller: new AbortController(),
        chunks: [0, 1].map((chunkIndex) => ({
            fileId: "file",
            collectionId: "collection",
            chunkIndex,
            offset: chunkIndex,
            size: 1,
            downloadedBytes: 0,
            status: "pending",
            attempts: 0,
        })),
        segments: [0, 1].map(() => ({
            type: "cdn",
            data: new Map([["url", "https://cdn.test/file"]]),
        })),
        partWriter,
        maxChunkRetries: 0,
        streamWriteBatchBytes: 1,
        priority: 0,
        startedAt: 0,
        collectionStartedAt: 0,
    } as unknown as FileDownloadRegistration;
    return {
        pool,
        input,
        partWriter,
        requestPool,
        payloadRequest,
        refreshSegments,
        repository,
        logger,
        onChunkSettled,
    };
}

async function flushMicrotasks() {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

describe("GlobalSegmentPool recovery", () => {
    afterEach(() => vi.useRealTimers());

    it.each(["full-segment", "byte-range"] as const)(
        "drains failed %s work before allowing a clean retry",
        async (mode) => {
            const { pool, input, partWriter, repository } = createRunningPool();
            input.mode = mode;
            input.ranges = new Map(
                input.chunks.map((chunk) => [
                    chunk.chunkIndex,
                    {
                        segmentIndex: chunk.chunkIndex,
                        localStart: 0,
                        localEnd: 1,
                    },
                ]),
            );
            const failed = Promise.withResolvers<number>();
            const sibling = Promise.withResolvers<number>();
            partWriter.writeChunkFromStream
                .mockImplementationOnce(() => failed.promise)
                .mockImplementationOnce(() => sibling.promise);
            pool.resize(2);
            let settled = false;
            const first = pool.register(input).then((outcome) => {
                settled = true;
                return outcome;
            });
            expect(partWriter.writeChunkFromStream).toHaveBeenCalledTimes(2);
            failed.reject(new Error("network failure"));
            await flushMicrotasks();
            expect(input.controller.signal.aborted).toBe(true);
            expect(settled).toBe(false);
            expect(pool.getOutstandingChunks("file")).not.toBeNull();
            sibling.reject(new DOMException("Delayed cancellation", "AbortError"));
            await expect(first).resolves.toBe("failed");
            expect(pool.getOutstandingChunks("file")).toBeNull();
            await expect(
                pool.register({ ...input, controller: new AbortController() }),
            ).resolves.toBe("completed");
            expect(repository.markChunkCompleted).toHaveBeenCalledTimes(2);
            expect(pool.getOutstandingChunks("file")).toBeNull();
        },
    );

    it("does not delete a replacement when stale completion runs", async () => {
        const { pool, input } = createRunningPool();
        type Internals = {
            sessions: Map<string, unknown>;
            finishSession: (session: unknown, outcome: string) => void;
        };
        const internals = pool as unknown as Internals;
        const old = pool.register(input);
        const oldSession = internals.sessions.get("file");
        pool.cancelSession("file");
        await expect(old).resolves.toBe("paused");
        const next = pool.register({ ...input, controller: new AbortController() });
        const nextSession = internals.sessions.get("file");
        internals.finishSession(oldSession, "failed");
        expect(internals.sessions.get("file")).toBe(nextSession);
        pool.cancelSession("file");
        await expect(next).resolves.toBe("paused");
    });

    it("settles and logs unexpected setup errors without losing a worker", async () => {
        const { pool, input, repository, logger, onChunkSettled } = createRunningPool();
        const error = new Error("write status failed");
        repository.markChunkDownloading.mockImplementationOnce(() => {
            throw error;
        });
        pool.resize(2);
        await expect(pool.register(input)).resolves.toBe("failed");
        expect(logger.error).toHaveBeenCalledWith(error, "DownloadService:processChunk");
        expect(onChunkSettled).toHaveBeenCalledTimes(3);
        expect(pool.getOutstandingChunks("file")).toBeNull();
        await expect(pool.register({ ...input, controller: new AbortController() })).resolves.toBe(
            "completed",
        );
    });

    it.each(["full-segment", "byte-range"] as const)(
        "retries with refreshed descriptors after an expired CDN credential (%s)",
        async (mode) => {
            const { pool, input, payloadRequest, refreshSegments, logger } = createRunningPool();
            input.mode = mode;
            input.ranges = new Map(
                input.chunks.map((chunk) => [
                    chunk.chunkIndex,
                    {
                        segmentIndex: chunk.chunkIndex,
                        localStart: 0,
                        localEnd: 1,
                    },
                ]),
            );
            payloadRequest
                .mockImplementationOnce(
                    async () =>
                        new Response("<Error><Message>Request has expired</Message></Error>", {
                            status: 403,
                            headers: { "content-type": "application/xml" },
                        }),
                )
                .mockImplementationOnce(async () => new Response("x"));
            pool.resize(1);

            await expect(pool.register(input)).resolves.toBe("completed");

            expect(refreshSegments).toHaveBeenCalledOnce();
            expect(refreshSegments).toHaveBeenCalledWith(
                input.collection,
                input.file,
                input.controller.signal,
            );
            expect(payloadRequest).toHaveBeenCalledTimes(3);
            expect(payloadRequest.mock.calls[0]?.[0]).toBe("https://cdn.test/file");
            expect(payloadRequest.mock.calls[1]?.[0]).toBe("https://cdn.test/fresh");
            expect(payloadRequest.mock.calls[2]?.[0]).toBe("https://cdn.test/fresh");
            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ reason: "segment-credential-refresh" }),
                "DownloadService:streamSegment",
            );
        },
    );

    it("fails a chunk without refreshing on a non-expiration CDN 403", async () => {
        const { pool, input, payloadRequest, refreshSegments, repository } = createRunningPool();
        payloadRequest.mockResolvedValue(
            new Response("<html>error code: 1020</html>", {
                status: 403,
                headers: { "content-type": "text/html" },
            }),
        );
        pool.resize(1);

        await expect(pool.register(input)).resolves.toBe("failed");

        expect(refreshSegments).not.toHaveBeenCalled();
        expect(repository.markChunkError).toHaveBeenCalled();
    });

    it("does not spend retries while waiting more than 15 seconds for payload permits", async () => {
        vi.useFakeTimers();
        const { pool, input, requestPool, payloadRequest, logger } = createRunningPool();
        const context = {
            collectionId: "other",
            providerId: "kiosk-download",
            direction: "download",
        } as const;
        const releases = [await requestPool.acquire(context), await requestPool.acquire(context)];
        pool.resize(2);
        const outcome = pool.register(input);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(payloadRequest).not.toHaveBeenCalled();
        expect(input.controller.signal.aborted).toBe(false);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
        releases.forEach((release) => release());
        await expect(outcome).resolves.toBe("completed");
        expect(payloadRequest).toHaveBeenCalledTimes(2);
    });
});
