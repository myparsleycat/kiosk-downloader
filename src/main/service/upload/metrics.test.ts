import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UploadTransferMetrics } from "./metrics";

describe("UploadTransferMetrics speed EMA", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("stays at 0 during warmup then seeds from the first measurable rate", () => {
        vi.setSystemTime(0);

        const metrics = new UploadTransferMetrics();
        metrics.registerFile("collection", "file");
        metrics.setChunkTransferProgress("file", 0, 1000);

        expect(metrics.sampleFile("file", 0).speedBps).toBe(0);

        vi.setSystemTime(400);
        metrics.setChunkTransferProgress("file", 0, 1400);
        expect(metrics.sampleFile("file", 0).speedBps).toBe(0);

        vi.setSystemTime(1000);
        metrics.setChunkTransferProgress("file", 0, 2000);
        expect(metrics.sampleFile("file", 0).speedBps).toBe(1000);
    });

    it("decays EMA toward 0 when transferred bytes stall", () => {
        vi.setSystemTime(0);

        const metrics = new UploadTransferMetrics();
        metrics.registerFile("collection", "file");
        metrics.sampleFile("file", 0);

        vi.setSystemTime(1000);
        metrics.setChunkTransferProgress("file", 0, 2000);
        const seeded = metrics.sampleFile("file", 0).speedBps;
        expect(seeded).toBe(2000);

        // Keep the rising edge out of the recent samples so instant rate is 0.
        vi.setSystemTime(2500);
        const stalled = metrics.sampleFile("file", 0).speedBps;
        expect(stalled).toBeLessThan(seeded);
        expect(stalled).toBeGreaterThan(0);
    });

    it("resets speed after clearFile", () => {
        vi.setSystemTime(0);

        const metrics = new UploadTransferMetrics();
        metrics.registerFile("collection", "file");
        metrics.setChunkTransferProgress("file", 0, 0);
        metrics.sampleFile("file", 0);

        vi.setSystemTime(1000);
        metrics.setChunkTransferProgress("file", 0, 2000);
        expect(metrics.sampleFile("file", 0).speedBps).toBeGreaterThan(0);

        metrics.clearFile("file");
        metrics.registerFile("collection", "file");
        expect(metrics.sampleFile("file", 0).speedBps).toBe(0);
    });

    it("clears cached speed after a sampling gap longer than the speed window", () => {
        vi.setSystemTime(0);

        const metrics = new UploadTransferMetrics();
        metrics.registerFile("collection", "file");
        metrics.sampleFile("file", 0);

        vi.setSystemTime(1000);
        metrics.setChunkTransferProgress("file", 0, 2000);
        expect(metrics.sampleFile("file", 0).speedBps).toBe(2000);

        // Gap > SPEED_WINDOW_MS (3s) leaves only the new sample → unmeasurable and stale.
        vi.setSystemTime(4500);
        expect(metrics.sampleFile("file", 0).speedBps).toBe(0);
        expect(metrics.getFileSnapshot("file", 0).speedBps).toBe(0);
    });

    it("aggregates segment dedup counters per collection and bundle", () => {
        const metrics = new UploadTransferMetrics();
        metrics.recordSegmentExists("col-a", 100);
        metrics.recordSegmentUploaded("col-a", 200);
        metrics.recordSegmentConflict("col-b", 50);
        metrics.recordSegmentUploaded("col-b", 25);

        expect(metrics.getSegmentDedupSnapshot("col-a")).toEqual({
            existsCount: 1,
            existsBytes: 100,
            conflictCount: 0,
            conflictBytes: 0,
            uploadedCount: 1,
            uploadedBytes: 200,
        });
        expect(metrics.getBundleSegmentDedupSnapshot(["col-a", "col-b"])).toEqual({
            existsCount: 1,
            existsBytes: 100,
            conflictCount: 1,
            conflictBytes: 50,
            uploadedCount: 2,
            uploadedBytes: 225,
        });

        metrics.clearCollection("col-a");
        expect(metrics.getSegmentDedupSnapshot("col-a")).toEqual({
            existsCount: 0,
            existsBytes: 0,
            conflictCount: 0,
            conflictBytes: 0,
            uploadedCount: 0,
            uploadedBytes: 0,
        });
        expect(metrics.getBundleSegmentDedupSnapshot(["col-a", "col-b"]).uploadedBytes).toBe(25);
    });
});
