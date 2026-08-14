import type { TransferProviderRequestId } from "@shared/settings";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    TransferRateLimitError,
    TransferScheduler,
    type TransferRequestContext,
} from "./transfer-request-pool";

describe("TransferScheduler", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("never exceeds the global payload cap", async () => {
        const scheduler = new TransferScheduler(4);
        const gates = Array.from({ length: 12 }, deferred);
        let active = 0;
        let peak = 0;
        const tasks = gates.map((gate, index) =>
            scheduler.runPayload(context("kiosk-download", `collection-${index % 3}`), async () => {
                active += 1;
                peak = Math.max(peak, active);
                await gate.promise;
                active -= 1;
            }),
        );

        await vi.waitFor(() => expect(active).toBe(4));
        for (const gate of gates) {
            gate.resolve();
            await Promise.resolve();
        }
        await Promise.all(tasks);

        expect(peak).toBe(4);
    });

    it("uses equal round-robin across collections and FIFO within each collection", async () => {
        const scheduler = new TransferScheduler(4);
        const blockers = await reserve(scheduler, context("kiosk-download", "blocker"), 4);
        const started: string[] = [];
        const releases: Array<() => void> = [];

        for (const collectionId of ["a", "a", "b", "b", "c", "c"]) {
            void scheduler.acquire(context("kiosk-download", collectionId)).then((release) => {
                started.push(collectionId);
                releases.push(release);
            });
        }

        blockers[0]();
        await vi.waitFor(() => expect(started).toEqual(["a"]));
        blockers[1]();
        await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
        blockers[2]();
        await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
        blockers[3]();
        await vi.waitFor(() => expect(started).toEqual(["a", "b", "c", "a"]));

        while (releases.length > 0) {
            releases.shift()!();
            await Promise.resolve();
        }
        await vi.waitFor(() => expect(started).toEqual(["a", "b", "c", "a", "b", "c"]));
        releases.forEach((release) => release());
    });

    it("enforces the Kiosk upload provider-global hard cap of eight", async () => {
        const scheduler = new TransferScheduler(16);
        const gates = Array.from({ length: 24 }, deferred);
        let activeUploads = 0;
        let peakUploads = 0;
        let activeTotal = 0;
        const tasks = gates.map((gate, index) => {
            const isUpload = index < 12;
            return scheduler.runPayload(
                context(
                    isUpload ? "kiosk-upload" : "kiosk-download",
                    isUpload ? `upload-${index % 3}` : `download-${index}`,
                ),
                async () => {
                    activeTotal += 1;
                    if (isUpload) {
                        activeUploads += 1;
                        peakUploads = Math.max(peakUploads, activeUploads);
                    }
                    await gate.promise;
                    activeTotal -= 1;
                    if (isUpload) {
                        activeUploads -= 1;
                    }
                },
            );
        });

        await vi.waitFor(() => expect(activeTotal).toBe(16));
        expect(activeUploads).toBe(8);
        gates.forEach((gate) => gate.resolve());
        await Promise.all(tasks);
        expect(peakUploads).toBe(8);
    });

    it("raises transfer.it collection concurrency after every two successes", async () => {
        const scheduler = new TransferScheduler(4);
        const gates = Array.from({ length: 4 }, deferred);
        const started: number[] = [];
        const tasks = gates.map((gate, index) =>
            scheduler.runPayload(context("transfer-it-download", "transfer"), async () => {
                started.push(index);
                await gate.promise;
            }),
        );

        await vi.waitFor(() => expect(started).toEqual([0]));
        gates[0].resolve();
        await vi.waitFor(() => expect(started).toEqual([0, 1]));
        gates[1].resolve();
        await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));

        gates.slice(2).forEach((gate) => gate.resolve());
        await Promise.all(tasks);
    });

    it("registers transfer.it cooldown before releasing the failed request slot", async () => {
        vi.useFakeTimers();
        const scheduler = new TransferScheduler(4);
        const blockers = await reserve(scheduler, context("kiosk-download", "blocker"), 3);
        const error = new TransferRateLimitError();
        const failed = scheduler.runPayload(
            context("transfer-it-download", "transfer"),
            async () => {
                throw error;
            },
        );
        const nextTask = vi.fn(async () => undefined);
        const next = scheduler.runPayload(context("transfer-it-download", "transfer"), nextTask);

        await expect(failed).rejects.toBe(error);
        expect(error.state).toEqual({
            consecutiveRateLimits: 1,
            cooldownMs: 2000,
            isNewEpisode: true,
            terminal: false,
        });
        await vi.advanceTimersByTimeAsync(1999);
        expect(nextTask).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await next;
        expect(nextTask).toHaveBeenCalledOnce();

        blockers.forEach((release) => release());
    });

    it("applies control-plane transfer.it limits before any payload is queued", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const scheduler = new TransferScheduler(8);
        const transferContext = context("transfer-it-download", "collection");
        const error = new TransferRateLimitError();

        expect(scheduler.reportRateLimit(transferContext, error)).toMatchObject({
            consecutiveRateLimits: 1,
            cooldownMs: 2_000,
            terminal: false,
        });
        const task = vi.fn(async () => undefined);
        const pending = scheduler.runPayload(transferContext, task);

        await vi.advanceTimersByTimeAsync(1_999);
        expect(task).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(task).toHaveBeenCalledOnce();
    });

    it("keeps a queued payload stream behind cooldown after a streaming 509", async () => {
        vi.useFakeTimers();
        const scheduler = new TransferScheduler(4);
        const blockers = await reserve(scheduler, context("kiosk-download", "blocker"), 3);
        const error = new TransferRateLimitError();
        const failed = consume(
            scheduler.runPayloadStream(
                context("transfer-it-download", "transfer"),
                async function* () {
                    yield await Promise.reject(error);
                },
            ),
        );
        const nextTask = vi.fn(async function* () {
            yield new Uint8Array([1]);
        });
        const next = consume(
            scheduler.runPayloadStream(context("transfer-it-download", "transfer"), nextTask),
        );

        await expect(failed).rejects.toBe(error);
        await vi.advanceTimersByTimeAsync(1999);
        expect(nextTask).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(next).resolves.toEqual([new Uint8Array([1])]);

        blockers.forEach((release) => release());
    });

    it("coalesces concurrent transfer.it rate limits into one cooldown episode", async () => {
        vi.useFakeTimers();
        const scheduler = new TransferScheduler(4);
        const transferContext = context("transfer-it-download", "transfer");
        await scheduler.runPayload(transferContext, async () => undefined);
        await scheduler.runPayload(transferContext, async () => undefined);

        const firstGate = deferred();
        const secondGate = deferred();
        let started = 0;
        const first = scheduler.runPayload(transferContext, async () => {
            started += 1;
            await firstGate.promise;
        });
        const second = scheduler.runPayload(transferContext, async () => {
            started += 1;
            await secondGate.promise;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(started).toBe(2);

        const firstError = new TransferRateLimitError();
        firstGate.reject(firstError);
        await expect(first).rejects.toBe(firstError);
        const secondError = new TransferRateLimitError();
        secondGate.reject(secondError);
        await expect(second).rejects.toBe(secondError);

        expect(firstError.state?.consecutiveRateLimits).toBe(1);
        expect(firstError.state?.isNewEpisode).toBe(true);
        expect(secondError.state?.consecutiveRateLimits).toBe(1);
        expect(secondError.state?.isNewEpisode).toBe(false);
    });

    it("exposes the third transfer.it rate-limit episode as terminal", async () => {
        vi.useFakeTimers();
        const scheduler = new TransferScheduler(4);

        for (const [index, expectedDelay] of [2000, 5000, 10000].entries()) {
            const error = new TransferRateLimitError(index === 1 ? 3000 : undefined);
            const failed = scheduler.runPayload(
                context("transfer-it-download", "transfer"),
                async () => {
                    throw error;
                },
            );
            await expect(failed).rejects.toBe(error);
            expect(error.state).toEqual({
                consecutiveRateLimits: index + 1,
                cooldownMs: expectedDelay,
                isNewEpisode: true,
                terminal: index === 2,
            });
            await vi.advanceTimersByTimeAsync(expectedDelay);
        }
    });

    it("removes aborted waiters without consuming a permit", async () => {
        const scheduler = new TransferScheduler(4);
        const active = await reserve(scheduler, context("kiosk-download", "active"), 4);
        const controller = new AbortController();
        const aborted = scheduler.runPayload(
            { ...context("kiosk-download", "aborted"), signal: controller.signal },
            vi.fn(async () => undefined),
        );
        const nextTask = vi.fn(async () => undefined);
        const next = scheduler.runPayload(context("kiosk-download", "next"), nextTask);

        controller.abort(new Error("cancelled"));
        await expect(aborted).rejects.toThrow("cancelled");
        active[0]();
        await next;
        expect(nextTask).toHaveBeenCalledOnce();
        active.slice(1).forEach((release) => release());
    });

    it("shrinks non-preemptively and grants queued work after active work reaches the new cap", async () => {
        const scheduler = new TransferScheduler(8);
        const active = await reserve(scheduler, context("kiosk-download", "active"), 8);
        const started: number[] = [];
        const pending = [0, 1].map((index) =>
            scheduler.acquire(context("kiosk-download", `pending-${index}`)).then((release) => {
                started.push(index);
                return release;
            }),
        );

        scheduler.resize(4);
        active.slice(0, 4).forEach((release) => release());
        await Promise.resolve();
        expect(started).toHaveLength(0);
        active[4]();
        await vi.waitFor(() => expect(started).toEqual([0]));

        active.slice(5).forEach((release) => release());
        const releases = await Promise.all(pending);
        releases.forEach((release) => release());
    });
});

function context(
    providerId: TransferProviderRequestId,
    collectionId: string,
): TransferRequestContext {
    return {
        collectionId,
        direction: providerId === "kiosk-upload" ? "upload" : "download",
        providerId,
    };
}

async function reserve(scheduler: TransferScheduler, value: TransferRequestContext, count: number) {
    return Promise.all(Array.from({ length: count }, () => scheduler.acquire(value)));
}

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, reject, resolve };
}

async function consume<T>(values: AsyncIterable<T>) {
    const result: T[] = [];
    for await (const value of values) {
        result.push(value);
    }
    return result;
}
