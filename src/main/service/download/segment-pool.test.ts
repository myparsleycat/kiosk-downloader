import { describe, expect, it, vi } from "vitest";

import { GlobalSegmentPool } from "./segment-pool";

function createPool() {
    return new GlobalSegmentPool({
        metrics: { registerFile: vi.fn() },
        onChunkSettled: vi.fn(),
    } as never);
}

function registration(collectionId: string, fileId: string, chunkCount: number) {
    return {
        collection: { id: collectionId },
        file: { id: fileId, downloadedBytes: 0 },
        chunks: Array.from({ length: chunkCount }, (_, chunkIndex) => ({ chunkIndex })),
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

    it("removes every queued chunk when a session is cancelled before workers start", async () => {
        const pool = createPool();
        const outcome = pool.register(registration("collection", "file", 2));

        pool.cancelSession("file");

        await expect(outcome).resolves.toBe("paused");
        expect((pool as unknown as { queue: unknown[] }).queue).toHaveLength(0);
    });

    it("creates workers only for queued work up to the configured size", () => {
        const pool = createPool();

        pool.resize(64);

        expect(pool.getTargetWorkers()).toBe(64);
        expect((pool as unknown as { runningWorkers: number }).runningWorkers).toBe(0);
    });
});
