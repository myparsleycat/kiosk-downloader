import { describe, expect, it } from "vitest";

import {
    cachedSpeedOrClearIfStale,
    SPEED_EMA_TAU_MS,
    TransferSpeedSampler,
    updateSpeedEma,
} from "./transfer-speed";

describe("updateSpeedEma", () => {
    it("seeds with the instant rate when there is no previous value", () => {
        expect(updateSpeedEma(undefined, 1000, 500, SPEED_EMA_TAU_MS)).toBe(1000);
    });

    it("smooths toward the instant rate between previous and instant values", () => {
        const next = updateSpeedEma(1000, 0, 500, SPEED_EMA_TAU_MS);
        expect(next).toBeGreaterThan(0);
        expect(next).toBeLessThan(1000);
    });

    it("keeps the previous value when dtMs is not positive", () => {
        expect(updateSpeedEma(1000, 0, 0, SPEED_EMA_TAU_MS)).toBe(1000);
        expect(updateSpeedEma(1000, 0, -10, SPEED_EMA_TAU_MS)).toBe(1000);
    });
});

describe("cachedSpeedOrClearIfStale", () => {
    it("returns the cached speed when the last update is still fresh", () => {
        const speedByKey = new Map([["file", 1000]]);
        const lastEmaAtByKey = new Map([["file", 1000]]);
        expect(cachedSpeedOrClearIfStale(1500, "file", speedByKey, lastEmaAtByKey, 2000)).toBe(
            1000,
        );
        expect(speedByKey.get("file")).toBe(1000);
    });

    it("clears stale cached speed after the speed window", () => {
        const speedByKey = new Map([["file", 1000]]);
        const lastEmaAtByKey = new Map([["file", 1000]]);
        expect(cachedSpeedOrClearIfStale(3001, "file", speedByKey, lastEmaAtByKey, 2000)).toBe(0);
        expect(speedByKey.has("file")).toBe(false);
        expect(lastEmaAtByKey.has("file")).toBe(false);
    });
});

describe("TransferSpeedSampler", () => {
    it("warms up, calculates EMA, and clears its state", () => {
        let now = 0;
        const sampler = new TransferSpeedSampler(() => now, 2000);

        expect(sampler.sample("file", 0)).toBe(0);
        now = 500;
        expect(sampler.sample("file", 500)).toBe(1000);
        now = 1000;
        expect(sampler.sample("file", 1500)).toBeGreaterThan(1000);
        expect(sampler.get("file")).toBeGreaterThan(1000);

        sampler.clear("file");
        expect(sampler.get("file")).toBe(0);
        expect(sampler.sample("file", 1500)).toBe(0);
    });

    it.each([2000, 3000])("clears cached speed after a %dms stale window", (windowMs) => {
        let now = 0;
        const sampler = new TransferSpeedSampler(() => now, windowMs);

        sampler.sample("file", 0);
        now = 500;
        expect(sampler.sample("file", 1000)).toBe(2000);
        now += windowMs + 1;

        expect(sampler.sample("file", 1000)).toBe(0);
        expect(sampler.get("file")).toBe(0);
    });
});
