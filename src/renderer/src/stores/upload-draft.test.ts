import { afterEach, describe, expect, it, vi } from "vitest";

import { mergeDateAndTime } from "./upload-draft";

describe("upload expiry", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("defaults omitted seconds to zero", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-15T00:00:00"));

        expect(new Date(mergeDateAndTime(new Date("2026-07-16T00:00:00"), "12:30"))).toEqual(
            new Date("2026-07-16T12:30:00"),
        );
    });

    it("preserves explicit seconds and defaults invalid components", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-15T00:00:00"));

        expect(new Date(mergeDateAndTime(new Date("2026-07-16T00:00:00"), "12:30:45"))).toEqual(
            new Date("2026-07-16T12:30:45"),
        );
        expect(new Date(mergeDateAndTime(new Date("2026-07-16T00:00:00"), "bad:30"))).toEqual(
            new Date("2026-07-16T00:30:00"),
        );
    });
});
