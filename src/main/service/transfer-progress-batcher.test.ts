import { afterEach, describe, expect, it, vi } from "vitest";

import { TransferProgressBatcher } from "./transfer-progress-batcher";

describe("TransferProgressBatcher", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("coalesces dirty files and still emits empty progress ticks", async () => {
        vi.useFakeTimers();
        const flush = vi.fn<(collectionId: string, fileIds: Set<string>) => Promise<void>>(
            async () => undefined,
        );
        const batcher = new TransferProgressBatcher(flush, vi.fn());

        batcher.mark("collection", "one");
        batcher.mark("collection", "two");
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(500);

        expect(flush).toHaveBeenCalledTimes(2);
        expect([...flush.mock.calls[0][1]]).toEqual(["one", "two"]);
        expect(flush.mock.calls[1][1].size).toBe(0);
        batcher.destroy();
    });

    it("preserves changes added during a flush and requeues failed changes", async () => {
        vi.useFakeTimers();
        let release: (() => void) | undefined;
        const flush = vi
            .fn<(collectionId: string, fileIds: Set<string>) => Promise<void>>()
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
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(500);

        expect([...flush.mock.calls[1][1]]).toEqual(["two"]);
        expect([...flush.mock.calls[2][1]]).toEqual(["two"]);
        expect(onError).toHaveBeenCalledTimes(1);
        batcher.destroy();
    });
});
