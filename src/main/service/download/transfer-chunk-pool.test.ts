import { afterEach, describe, expect, it, vi } from "vitest";

import { TransferScheduler } from "../transfer-request-pool";
import { TransferChunkPool, type TransferFileRegistration } from "./transfer-chunk-pool";
import { TRANSFER_RATE_LIMIT_ERROR } from "./transfer-it-api-client";

function createHarness(payloadRequest: ReturnType<typeof vi.fn>) {
    const requestPool = new TransferScheduler(8);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const repository = {
        markFileStatus: vi.fn(),
        markChunkDownloading: vi.fn(),
        markChunkPending: vi.fn(),
        markChunkPartial: vi.fn(),
        markChunkCompleted: vi.fn(),
        markChunkError: vi.fn(),
        syncFileDownloadedBytes: vi.fn(),
        getFile: vi.fn(() => ({ downloadedBytes: 0 })),
    };
    const getDownloadUrl = vi.fn(async () => ({ url: "https://cdn.test/file" }));
    const pool = new TransferChunkPool({
        kd: {
            http: { payloadRequest },
            logger,
            service: {
                transfer: {
                    downloadBandwidth: { take: vi.fn(async () => undefined) },
                    requestPool,
                },
            },
        } as never,
        api: { getDownloadUrl } as never,
        repository: repository as never,
        metrics: {
            registerFile: vi.fn(),
            setChunkTransferProgress: vi.fn(),
            setChunkWriteProgress: vi.fn(),
            clearChunk: vi.fn(),
        } as never,
        onChunkSettled: vi.fn(),
        onProgress: vi.fn(),
    });
    return { pool, requestPool, repository, getDownloadUrl };
}

function registration(chunkCount = 1): TransferFileRegistration {
    const chunks = Array.from({ length: chunkCount }, (_, chunkIndex) => ({
        collectionId: "collection",
        fileId: "file",
        chunkIndex,
        offset: chunkIndex * 16,
        size: 16,
        status: "pending" as const,
        downloadedBytes: 0,
        attempts: 0,
        updatedAt: "",
        error: null,
    }));
    return {
        collection: { id: "collection", shareId: "share" },
        file: { id: "file", remoteId: "remote", downloadedBytes: 0 },
        nodeKey: Buffer.alloc(32),
        partWriter: {
            writeChunkFromStream: async (
                _offset: number,
                _chunkIndex: number,
                source: AsyncIterable<Uint8Array>,
                _size: number,
                _batchSize: number,
                callbacks: { onWriteProgress?: (bytes: number) => void } | undefined,
                options: { alreadyWritten: number },
            ) => {
                let written = options.alreadyWritten;
                for await (const bytes of source) {
                    written += bytes.length;
                    callbacks?.onWriteProgress?.(written);
                }
                return written;
            },
        },
        controller: new AbortController(),
        maxChunkRetries: 5,
        priority: 0,
        chunks,
        startedAt: 0,
        collectionStartedAt: 0,
    } as TransferFileRegistration;
}

function successResponse(range: string | null) {
    const match = range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) {
        throw new Error(`Unexpected range ${range}.`);
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(Buffer.alloc(end - start + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/1000000` },
    });
}

async function flush() {
    for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
    }
}

afterEach(() => {
    vi.useRealTimers();
});

describe("TransferChunkPool", () => {
    it("submits every CDN range through the central payload scheduler", async () => {
        const payloadRequest = vi.fn(
            async (_url: string, options: { headers: { Range: string } }) =>
                successResponse(options.headers.Range),
        );
        const { pool, requestPool, repository } = createHarness(payloadRequest);
        const runPayloadStream = vi.spyOn(requestPool, "runPayloadStream");
        pool.start(8);

        await expect(pool.register(registration(4))).resolves.toBe("completed");

        expect(payloadRequest).toHaveBeenCalledTimes(4);
        expect(runPayloadStream).toHaveBeenCalledTimes(4);
        expect(repository.markChunkCompleted).toHaveBeenCalledTimes(4);
    });

    it("releases the permit before refreshing an expired CDN URL", async () => {
        const payloadRequest = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 403 }))
            .mockImplementation(async (_url: string, options: { headers: { Range: string } }) =>
                successResponse(options.headers.Range),
            );
        const { pool, requestPool, getDownloadUrl } = createHarness(payloadRequest);
        const runPayloadStream = vi.spyOn(requestPool, "runPayloadStream");
        pool.start(8);

        await expect(pool.register(registration())).resolves.toBe("completed");

        expect(runPayloadStream).toHaveBeenCalledTimes(2);
        expect(getDownloadUrl).toHaveBeenCalledTimes(2);
    });

    it("terminates after three single-worker rate-limit episodes", async () => {
        vi.useFakeTimers();
        const payloadRequest = vi.fn(async () => new Response(null, { status: 509 }));
        const { pool, repository } = createHarness(payloadRequest);
        pool.start(8);
        const outcome = pool.register(registration());

        await flush();
        expect(payloadRequest).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(payloadRequest).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(outcome).resolves.toBe("failed");

        expect(payloadRequest).toHaveBeenCalledTimes(3);
        expect(repository.markChunkError).toHaveBeenCalledWith(
            expect.anything(),
            TRANSFER_RATE_LIMIT_ERROR,
        );
    });

    it("aborts a shared cooldown without leaving queued chunks", async () => {
        vi.useFakeTimers();
        const payloadRequest = vi.fn(async () => new Response(null, { status: 509 }));
        const { pool } = createHarness(payloadRequest);
        const item = registration();
        pool.start(8);
        const outcome = pool.register(item);

        await flush();
        item.controller.abort();

        await expect(outcome).resolves.toBe("paused");
        expect((pool as unknown as { queue: unknown[] }).queue).toHaveLength(0);
    });
});
