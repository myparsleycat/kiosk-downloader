import { afterEach, describe, expect, it, vi } from "vitest";

import { TransferChunkPool } from "./transfer-chunk-pool";
import { parseTransferRetryAfterMs } from "./transfer-it-api-client";

function createHarness(request: ReturnType<typeof vi.fn>) {
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
    const metrics = {
        registerFile: vi.fn(),
        setChunkTransferProgress: vi.fn(),
        setChunkWriteProgress: vi.fn(),
        clearChunk: vi.fn(),
    };
    const pool = new TransferChunkPool({
        kd: {
            http: { request },
            logger,
            service: {
                transfer: { downloadBandwidth: { take: vi.fn(async () => undefined) } },
            },
        } as never,
        api: {
            getDownloadUrl: vi.fn(async () => ({ url: "https://cdn.test/file" })),
        } as never,
        repository: repository as never,
        metrics: metrics as never,
        onChunkSettled: vi.fn(),
        onProgress: vi.fn(),
    });
    return { pool, logger, repository };
}

function createRegistration(chunkCount: number) {
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
        collection: { id: "collection", shareId: "share" } as never,
        file: { id: "file", remoteId: "remote", downloadedBytes: 0 } as never,
        nodeKey: Buffer.alloc(32),
        partWriter: {
            writeChunkFromStream: vi.fn(
                async (
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
            ),
        } as never,
        controller: new AbortController(),
        maxChunkRetries: 5,
        priority: 0,
        chunks,
        startedAt: 0,
        collectionStartedAt: 0,
    };
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

function rateLimitResponse(retryAfter?: string) {
    const cancel = vi.fn(async () => undefined);
    return {
        response: {
            status: 509,
            headers: new Headers(retryAfter ? { "retry-after": retryAfter } : undefined),
            body: { cancel },
        },
        cancel,
    };
}

async function flush() {
    for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
    }
}

afterEach(() => {
    vi.useRealTimers();
});

describe("TransferChunkPool adaptive concurrency", () => {
    it("starts with one worker and increases once per two successful chunks up to four", async () => {
        const request = vi.fn(async (_url: string, options: { headers: { Range: string } }) =>
            successResponse(options.headers.Range),
        );
        const { pool, logger } = createHarness(request);
        pool.start();

        await expect(pool.register(createRegistration(24))).resolves.toBe("completed");

        expect(
            logger.info.mock.calls.map(
                ([context]) => (context as { currentWorkers: number }).currentWorkers,
            ),
        ).toEqual([2, 3, 4]);
        expect(request).toHaveBeenCalledTimes(24);
    });

    it("cancels a 509 body, waits for the shared cooldown, and retries the same chunk", async () => {
        vi.useFakeTimers();
        const limited = rateLimitResponse("3");
        const request = vi
            .fn()
            .mockResolvedValueOnce(limited.response)
            .mockImplementation(async (_url: string, options: { headers: { Range: string } }) =>
                successResponse(options.headers.Range),
            );
        const { pool, logger } = createHarness(request);
        pool.start();
        const outcome = pool.register(createRegistration(1));
        await flush();

        expect(request).toHaveBeenCalledTimes(1);
        expect(limited.cancel).toHaveBeenCalledOnce();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                currentWorkers: 1,
                consecutiveRateLimits: 1,
                cooldownMs: 3000,
                retryAfterMs: 3000,
            }),
            "TransferChunkPool:rateLimited",
        );

        await vi.advanceTimersByTimeAsync(2999);
        expect(request).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(outcome).resolves.toBe("completed");
        expect(request).toHaveBeenCalledTimes(2);
    });

    it("coalesces concurrent 509 responses into one rate-limit episode", async () => {
        vi.useFakeTimers();
        const pending: Array<(response: unknown) => void> = [];
        const ranges: string[] = [];
        let calls = 0;
        const request = vi.fn(async (_url: string, options: { headers: { Range: string } }) => {
            calls += 1;
            ranges.push(options.headers.Range);
            if (calls <= 8) {
                return successResponse(options.headers.Range);
            }
            return await new Promise((resolve) => pending.push(resolve));
        });
        const { pool, logger } = createHarness(request);
        pool.start();
        const registration = createRegistration(10);
        const outcome = pool.register(registration);
        for (let index = 0; index < 10 && pending.length < 2; index += 1) {
            await flush();
        }
        expect(pending).toHaveLength(2);

        pending[0]?.(rateLimitResponse().response);
        pending[1]?.(rateLimitResponse().response);
        await flush();

        const episodes = logger.warn.mock.calls
            .filter(([, message]) => message === "TransferChunkPool:rateLimited")
            .map(([context]) => context as { coalesced: boolean; consecutiveRateLimits: number });
        expect(episodes).toHaveLength(2);
        expect(episodes.map((episode) => episode.consecutiveRateLimits)).toEqual([1, 1]);
        expect(episodes.map((episode) => episode.coalesced)).toEqual(
            expect.arrayContaining([false, true]),
        );

        await vi.advanceTimersByTimeAsync(2000);
        await flush();
        expect(request).toHaveBeenCalledTimes(11);

        pool.cancelSession("file");
        registration.controller.abort();
        pending[2]?.(successResponse(ranges[10] ?? null));
        await expect(outcome).resolves.toBe("paused");
    });

    it("keeps consecutive rate-limit strikes when another chunk succeeds during cooldown", async () => {
        vi.useFakeTimers();
        const pending: Array<(response: unknown) => void> = [];
        let calls = 0;
        const request = vi.fn(async (_url: string, options: { headers: { Range: string } }) => {
            calls += 1;
            if (calls <= 8) {
                return successResponse(options.headers.Range);
            }
            return await new Promise((resolve) => pending.push(resolve));
        });
        const { pool, logger } = createHarness(request);
        pool.start();
        const registration = createRegistration(10);
        const outcome = pool.register(registration);
        for (let index = 0; index < 10 && pending.length < 2; index += 1) {
            await flush();
        }
        expect(pending).toHaveLength(2);

        pending[0]?.(rateLimitResponse().response);
        pending[1]?.(successResponse("bytes=144-159"));
        await flush();

        expect(
            logger.warn.mock.calls
                .filter(([, message]) => message === "TransferChunkPool:rateLimited")
                .map(
                    ([context]) =>
                        (context as { consecutiveRateLimits: number }).consecutiveRateLimits,
                ),
        ).toEqual([1]);

        await vi.advanceTimersByTimeAsync(2000);
        await flush();

        for (let index = 0; index < 10 && pending.length < 3; index += 1) {
            await flush();
        }
        expect(pending.length).toBeGreaterThanOrEqual(3);
        pending[2]?.(rateLimitResponse().response);
        await flush();

        const episodes = logger.warn.mock.calls
            .filter(([, message]) => message === "TransferChunkPool:rateLimited")
            .map(
                ([context]) => (context as { consecutiveRateLimits: number }).consecutiveRateLimits,
            );
        expect(episodes).toEqual([1, 2]);

        pool.cancelSession("file");
        registration.controller.abort();
        await expect(outcome).resolves.toBe("paused");
    });

    it("fails with the user-facing error after three consecutive single-worker limits", async () => {
        vi.useFakeTimers();
        const request = vi.fn(async () => rateLimitResponse().response);
        const { pool, repository } = createHarness(request);
        pool.start();
        const outcome = pool.register(createRegistration(1));
        await flush();
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(5000);
        await flush();

        await expect(outcome).resolves.toBe("failed");
        expect(request).toHaveBeenCalledTimes(3);
        expect(repository.markFileStatus).toHaveBeenCalledWith(
            "file",
            "error",
            "Transfer 서버가 다운로드 요청을 제한했습니다. 잠시 후 다시 시도해 주세요.",
        );
    });

    it("aborts a cooldown immediately when the session is cancelled", async () => {
        vi.useFakeTimers();
        const request = vi.fn(async () => rateLimitResponse().response);
        const { pool } = createHarness(request);
        pool.start();
        const registration = createRegistration(1);
        const outcome = pool.register(registration);
        await flush();

        pool.cancelSession("file");
        registration.controller.abort();

        await expect(outcome).resolves.toBe("paused");
        expect(request).toHaveBeenCalledOnce();
    });
});

describe("parseTransferRetryAfterMs", () => {
    it("supports delay seconds and HTTP dates", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

        expect(parseTransferRetryAfterMs("7")).toBe(7000);
        expect(parseTransferRetryAfterMs("Thu, 01 Jan 2026 00:00:09 GMT")).toBe(9000);
        expect(parseTransferRetryAfterMs("invalid")).toBeUndefined();
    });
});
