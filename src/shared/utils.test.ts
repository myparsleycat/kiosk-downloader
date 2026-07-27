import { enUS, ko, zhCN } from "date-fns/locale";
import { describe, expect, it } from "vitest";

import {
    formatSize,
    formatSpeed,
    formatTime,
    normalizePath,
    resolveDateFnsLocale,
    toErrorMessage,
} from "./utils";

describe("toErrorMessage", () => {
    it("returns the message of an Error", () => {
        expect(toErrorMessage(new Error("boom"))).toBe("boom");
    });

    it("stringifies non-Error values", () => {
        expect(toErrorMessage("plain")).toBe("plain");
        expect(toErrorMessage(42)).toBe("42");
        expect(toErrorMessage({ x: 1 })).toBe("[object Object]");
        expect(toErrorMessage(null)).toBe("null");
    });
});

describe("formatSize", () => {
    it("returns '0 B' for null, undefined, and 0", () => {
        expect(formatSize(null)).toBe("0 B");
        expect(formatSize(undefined)).toBe("0 B");
        expect(formatSize(0)).toBe("0 B");
    });

    it("returns '--' for non-finite values", () => {
        expect(formatSize(NaN)).toBe("--");
        expect(formatSize(Infinity)).toBe("--");
        expect(formatSize(-Infinity)).toBe("--");
    });

    it("formats sub-KB byte counts verbatim", () => {
        expect(formatSize(1)).toBe("1 B");
        expect(formatSize(512)).toBe("512 B");
    });

    it("formats a full kibibyte as 1 KB (JEDEC)", () => {
        expect(formatSize(1024)).toBe("1 KB");
    });

    it("pins large sizes to GB scale instead of auto-selecting a higher unit", () => {
        // 1000 MiB sits right at the threshold; the output stays in GB even
        // when the auto-exponent would otherwise have shown TB.
        expect(formatSize(1000 * 1024 * 1024)).toMatch(/ GB$/);
        expect(formatSize(5_000_000_000_000)).toMatch(/ GB$/);
    });

    it("respects an explicit exponent option and does not override it", () => {
        expect(formatSize(5_000_000_000_000, { exponent: 4 })).toMatch(/ TB$/);
    });
});

describe("formatSpeed", () => {
    it("returns null for nil, non-finite, and non-positive inputs", () => {
        expect(formatSpeed(null)).toBeNull();
        expect(formatSpeed(undefined)).toBeNull();
        expect(formatSpeed(NaN)).toBeNull();
        expect(formatSpeed(0)).toBeNull();
        expect(formatSpeed(-100)).toBeNull();
    });

    it("formats a positive rate in IEC units with a /s suffix", () => {
        expect(formatSpeed(1024)).toBe("1 KiB/s");
        expect(formatSpeed(2 * 1024 * 1024)).toBe("2 MiB/s");
    });
});

describe("resolveDateFnsLocale", () => {
    it("maps ko-prefixed language tags to the Korean locale", () => {
        expect(resolveDateFnsLocale("ko")).toBe(ko);
        expect(resolveDateFnsLocale("ko-KR")).toBe(ko);
    });

    it("maps zh-prefixed language tags to the Chinese locale", () => {
        expect(resolveDateFnsLocale("zh")).toBe(zhCN);
        expect(resolveDateFnsLocale("zh-CN")).toBe(zhCN);
    });

    it("falls back to en-US for anything else, including nil", () => {
        expect(resolveDateFnsLocale("en")).toBe(enUS);
        expect(resolveDateFnsLocale("fr")).toBe(enUS);
        expect(resolveDateFnsLocale(null)).toBe(enUS);
        expect(resolveDateFnsLocale(undefined)).toBe(enUS);
    });
});

describe("formatTime", () => {
    it("returns '--' for non-finite or negative inputs", () => {
        expect(formatTime(-1)).toBe("--");
        expect(formatTime(NaN)).toBe("--");
        expect(formatTime(Infinity)).toBe("--");
    });

    it("formats zero seconds as '0 seconds' in English", () => {
        expect(formatTime(0)).toBe("0 seconds");
    });

    it("formats a sub-minute duration as seconds only", () => {
        expect(formatTime(30)).toBe("30 seconds");
    });

    it("includes hours, minutes, and seconds and rounds up partial seconds", () => {
        expect(formatTime(3661)).toBe("1 hour 1 minute 1 second");
        // 59.5s rounds up to 60s → 1 minute.
        expect(formatTime(59.5)).toBe("1 minute");
    });

    it("produces a localized string for Korean and Chinese", () => {
        // Exact wording is locale-defined; assert it differs from the English
        // rendering and is non-empty.
        const en = formatTime(60, "en");
        const koStr = formatTime(60, "ko");
        const zhStr = formatTime(60, "zh");
        expect(koStr.length).toBeGreaterThan(0);
        expect(zhStr.length).toBeGreaterThan(0);
        expect(koStr).not.toBe(en);
        expect(zhStr).not.toBe(en);
    });
});

describe("normalizePath", () => {
    it("converts backslashes to forward slashes", () => {
        expect(normalizePath("a\\b\\c")).toBe("a/b/c");
    });

    it("strips leading and trailing slashes", () => {
        expect(normalizePath("/a/b/")).toBe("a/b");
        expect(normalizePath("/a/b")).toBe("a/b");
        expect(normalizePath("a/b/")).toBe("a/b");
    });

    it("handles mixed separators", () => {
        expect(normalizePath("\\a/b\\c/")).toBe("a/b/c");
    });

    it("returns an empty string for a root-only path", () => {
        expect(normalizePath("/")).toBe("");
        expect(normalizePath("\\")).toBe("");
    });
});
