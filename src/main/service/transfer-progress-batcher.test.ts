import { afterEach, describe, expect, it, vi } from "vitest";

import { TransferProgressBatcher } from "./transfer-progress-batcher";

describe("TransferProgressBatcher", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("coalesces dirty files and skips empty progress ticks", async () => {
        vi.useFakeTimers();
        const flush = vi.fn<
            (collectionId: string, fileIds: Set<string>, usageDirty: boolean) => Promise<void>
        >(async () => undefined);
        const batcher = new TransferProgressBatcher(flush, vi.fn());

        batcher.mark("collection", "one");
        batcher.mark("collection", "two");
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(500);

        expect(flush).toHaveBeenCalledTimes(1);
        expect([...flush.mock.calls[0][1]]).toEqual(["one", "two"]);
        batcher.destroy();
    });

    it("preserves changes added during a flush and requeues failed changes", async () => {
        vi.useFakeTimers();
        let release: (() => void) | undefined;
        const flush = vi
            .fn<
                (collectionId: string, fileIds: Set<string>, usageDirty: boolean) => Promise<void>
            >()
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        release = resolve;
                    }),
            )
            .mockRejectedValueOnce(new Error("failed"))
            .mockResolvedValue(undefined);
        const onError = vi.fn();
        const batcher = new TransferProgressBatcher(flush, onError);

        batcher.mark("collection", "one");
        await vi.advanceTimersByTimeAsync(500);
        batcher.mark("collection", "two");
        await vi.advanceTimersByTimeAsync(500);
        expect(flush).toHaveBeenCalledTimes(1);

        release?.();
        await Promise.resolve();
        await Promise.resolve();
        expect(flush).toHaveBeenCalledTimes(2);
        expect([...flush.mock.calls[1][1]]).toEqual(["two"]);
        expect(onError).toHaveBeenCalledTimes(1);

        // Failed ids stay dirty, but retry waits for the next poll tick.
        await Promise.resolve();
        expect(flush).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(500);
        expect(flush).toHaveBeenCalledTimes(3);
        expect([...flush.mock.calls[2][1]]).toEqual(["two"]);
        batcher.destroy();
    });

    it("flushes collection-only usage marks with an empty file id set", async () => {
        vi.useFakeTimers();
        const flush = vi.fn<
            (collectionId: string, fileIds: Set<string>, usageDirty: boolean) => Promise<void>
        >(async () => undefined);
        const batcher = new TransferProgressBatcher(flush, vi.fn());

        batcher.markCollection("collection");
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(500);

        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush.mock.calls[0][0]).toBe("collection");
        expect([...flush.mock.calls[0][1]]).toEqual([]);
        expect(flush.mock.calls[0][2]).toBe(true);
        batcher.destroy();
    });

    it("coalesces usage marks with file progress into one flush", async () => {
        vi.useFakeTimers();
        const flush = vi.fn<
            (collectionId: string, fileIds: Set<string>, usageDirty: boolean) => Promise<void>
        >(async () => undefined);
        const batcher = new TransferProgressBatcher(flush, vi.fn());

        batcher.mark("collection", "one");
        batcher.markCollection("collection");
        await vi.advanceTimersByTimeAsync(500);

        expect(flush).toHaveBeenCalledTimes(1);
        expect([...flush.mock.calls[0][1]]).toEqual(["one"]);
        expect(flush.mock.calls[0][2]).toBe(true);
        batcher.destroy();
    });

    it("drops collection marks after deactivation", async () => {
        vi.useFakeTimers();
        const flush = vi.fn<
            (collectionId: string, fileIds: Set<string>, usageDirty: boolean) => Promise<void>
        >(async () => undefined);
        const batcher = new TransferProgressBatcher(flush, vi.fn());

        batcher.markCollection("collection");
        batcher.deactivate("collection");
        await vi.advanceTimersByTimeAsync(500);

        expect(flush).not.toHaveBeenCalled();
        batcher.destroy();
    });

    it("requeues usage marks when the flush fails", async () => {
        vi.useFakeTimers();
        const flush = vi
            .fn<
                (collectionId: string, fileIds: Set<string>, usageDirty: boolean) => Promise<void>
            >()
            .mockRejectedValueOnce(new Error("failed"))
            .mockResolvedValue(undefined);
        const onError = vi.fn();
        const batcher = new TransferProgressBatcher(flush, onError);

        batcher.markCollection("collection");
        await vi.advanceTimersByTimeAsync(500);
        expect(flush).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledTimes(1);

        // Retry waits for the next poll tick.
        await Promise.resolve();
        expect(flush).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(500);
        expect(flush).toHaveBeenCalledTimes(2);
        expect(flush.mock.calls[1][0]).toBe("collection");
        expect([...flush.mock.calls[1][1]]).toEqual([]);
        expect(flush.mock.calls[1][2]).toBe(true);
        batcher.destroy();
    });
});
