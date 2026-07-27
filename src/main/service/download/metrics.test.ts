import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DownloadTransferMetrics } from "./metrics";

describe("DownloadTransferMetrics live progress", () => {
    it("advances live bytes on transfer before disk write batches", () => {
        const metrics = new DownloadTransferMetrics();
        metrics.registerFile("collection", "file", 1000);

        metrics.setChunkTransferProgress("file", 0, 400);
        expect(metrics.sampleFile("file", 1000).liveDownloaded).toBe(1400);
        expect(metrics.getCollectionSnapshot("collection").activeTransferredBytes).toBe(400);

        metrics.setChunkWriteProgress("file", 0, 200);
        expect(metrics.sampleFile("file", 1000).liveDownloaded).toBe(1400);

        metrics.setChunkWriteProgress("file", 0, 500);
        expect(metrics.sampleFile("file", 1000).liveDownloaded).toBe(1500);

        metrics.clearChunk("file", 0, 1500);
        expect(metrics.sampleFile("file", 1500).liveDownloaded).toBe(1500);
        expect(metrics.getCollectionSnapshot("collection").activeTransferredBytes).toBe(0);
    });
});

describe("DownloadTransferMetrics speed EMA", () => {
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

        const metrics = new DownloadTransferMetrics();
        metrics.registerFile("collection", "file", 0);
        metrics.setChunkTransferProgress("file", 0, 1000);

        expect(metrics.sampleFile("file", 0).speedBps).toBe(0);

        vi.setSystemTime(400);
        metrics.setChunkTransferProgress("file", 0, 1400);
        expect(metrics.sampleFile("file", 0).speedBps).toBe(0);

        vi.setSystemTime(1000);
        metrics.setChunkTransferProgress("file", 0, 2000);
        // Window: 1000 bytes over 1000ms => 1000 B/s seed
        expect(metrics.sampleFile("file", 0).speedBps).toBe(1000);
    });

    it("decays EMA toward 0 when transferred bytes stall", () => {
        vi.setSystemTime(0);

        const metrics = new DownloadTransferMetrics();
        metrics.registerFile("collection", "file", 0);
        metrics.sampleFile("file", 0);

        vi.setSystemTime(1000);
        metrics.setChunkTransferProgress("file", 0, 2000);
        const seeded = metrics.sampleFile("file", 0).speedBps;
        expect(seeded).toBe(2000);

        // Keep the rising edge out of the 2s window so instant rate is 0.
        vi.setSystemTime(2500);
        const stalled = metrics.sampleFile("file", 0).speedBps;
        expect(stalled).toBeLessThan(seeded);
        expect(stalled).toBeGreaterThan(0);
    });

    it("resets speed after clearFile", () => {
        vi.setSystemTime(0);

        const metrics = new DownloadTransferMetrics();
        metrics.registerFile("collection", "file", 0);
        metrics.setChunkTransferProgress("file", 0, 0);
        metrics.sampleFile("file", 0);

        vi.setSystemTime(1000);
        metrics.setChunkTransferProgress("file", 0, 2000);
        expect(metrics.sampleFile("file", 0).speedBps).toBeGreaterThan(0);

        metrics.clearFile("file");
        metrics.registerFile("collection", "file", 0);
        expect(metrics.sampleFile("file", 0).speedBps).toBe(0);
    });

    it("clears cached speed after a sampling gap longer than the speed window", () => {
        vi.setSystemTime(0);

        const metrics = new DownloadTransferMetrics();
        metrics.registerFile("collection", "file", 0);
        metrics.sampleFile("file", 0);

        vi.setSystemTime(1000);
        metrics.setChunkTransferProgress("file", 0, 2000);
        expect(metrics.sampleFile("file", 0).speedBps).toBe(2000);

        // Gap > SPEED_WINDOW_MS leaves only the new sample → unmeasurable and stale.
        vi.setSystemTime(3500);
        expect(metrics.sampleFile("file", 0).speedBps).toBe(0);
        expect(metrics.getFileSnapshot("file", 0).speedBps).toBe(0);
    });
});
