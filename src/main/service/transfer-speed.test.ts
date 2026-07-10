import { describe, expect, it } from "vitest";

import { cachedSpeedOrClearIfStale, SPEED_EMA_TAU_MS, updateSpeedEma } from "./transfer-speed";

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
