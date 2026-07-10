import { describe, expect, it, vi } from "vitest";

import {
    getAggregateProgress,
    resolveOsProgressBarMode,
    syncMainWindowProgressBar,
    toOsProgressTransfer,
    type OsProgressTransfer,
} from "./os-progress-bar";

function transfer(
    partial: Partial<OsProgressTransfer> & Pick<OsProgressTransfer, "status">,
): OsProgressTransfer {
    return {
        totalSize: 0,
        transferedSize: 0,
        progress: 0,
        ...partial,
    };
}

describe("getAggregateProgress", () => {
    it("returns null when nothing remains", () => {
        expect(
            getAggregateProgress([
                transfer({ status: "completed", totalSize: 100, transferedSize: 100 }),
                transfer({ status: "canceled" }),
            ]),
        ).toBeNull();
    });

    it("aggregates by bytes when sizes are known", () => {
        expect(
            getAggregateProgress([
                transfer({ status: "progress", totalSize: 100, transferedSize: 25 }),
                transfer({ status: "progress", totalSize: 100, transferedSize: 75 }),
            ]),
        ).toBe(50);
    });

    it("falls back to progress average when sizes are unknown", () => {
        expect(
            getAggregateProgress([
                transfer({ status: "progress", progress: 20 }),
                transfer({ status: "progress", progress: 80 }),
            ]),
        ).toBe(50);
    });

    it("clamps transferred bytes to total size", () => {
        expect(
            getAggregateProgress([
                transfer({ status: "progress", totalSize: 100, transferedSize: 150 }),
            ]),
        ).toBe(100);
    });
});

describe("resolveOsProgressBarMode", () => {
    it("prefers normal over preparing/paused/error", () => {
        expect(
            resolveOsProgressBarMode([
                transfer({ status: "progress" }),
                transfer({ status: "pending" }),
                transfer({ status: "paused" }),
                transfer({ status: "error" }),
            ]),
        ).toBe("normal");
    });

    it("uses indeterminate for pending/preparing", () => {
        expect(
            resolveOsProgressBarMode([
                transfer({ status: "pending" }),
                transfer({ status: "paused" }),
            ]),
        ).toBe("indeterminate");
    });

    it("uses paused before error", () => {
        expect(
            resolveOsProgressBarMode([
                transfer({ status: "paused" }),
                transfer({ status: "error" }),
            ]),
        ).toBe("paused");
    });

    it("returns null when only terminal transfers remain", () => {
        expect(
            resolveOsProgressBarMode([
                transfer({ status: "completed" }),
                transfer({ status: "canceled" }),
            ]),
        ).toBeNull();
    });
});

describe("toOsProgressTransfer", () => {
    it("maps app statuses and computes progress", () => {
        expect(
            toOsProgressTransfer({
                status: "downloading",
                transferredBytes: 25,
                totalBytes: 100,
            }),
        ).toEqual({
            status: "progress",
            totalSize: 100,
            transferedSize: 25,
            progress: 25,
        });
        expect(
            toOsProgressTransfer({
                status: "expired",
                transferredBytes: 0,
                totalBytes: 0,
            }).status,
        ).toBe("canceled");
        expect(
            toOsProgressTransfer({
                status: "queued",
                transferredBytes: 0,
                totalBytes: 0,
            }).status,
        ).toBe("pending");
    });
});

describe("syncMainWindowProgressBar", () => {
    it("hides the bar when there are no remaining transfers", () => {
        const setProgressBar = vi.fn();
        syncMainWindowProgressBar({ isDestroyed: () => false, setProgressBar } as never, [
            transfer({ status: "completed", totalSize: 10, transferedSize: 10 }),
        ]);
        expect(setProgressBar).toHaveBeenCalledWith(-1);
    });

    it("sets normalized progress with mode", () => {
        const setProgressBar = vi.fn();
        syncMainWindowProgressBar({ isDestroyed: () => false, setProgressBar } as never, [
            transfer({ status: "progress", totalSize: 200, transferedSize: 50 }),
        ]);
        expect(setProgressBar).toHaveBeenCalledWith(0.25, { mode: "normal" });
    });

    it("ignores destroyed windows", () => {
        const setProgressBar = vi.fn();
        syncMainWindowProgressBar({ isDestroyed: () => true, setProgressBar } as never, [
            transfer({ status: "progress", totalSize: 100, transferedSize: 10 }),
        ]);
        expect(setProgressBar).not.toHaveBeenCalled();
    });
});
