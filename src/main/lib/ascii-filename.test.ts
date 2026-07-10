import path from "node:path";

import { describe, expect, it } from "vitest";

import { FS } from "./fs";

const fs = new FS({} as never);

describe("toAsciiFilename", () => {
    it("transliterates hangul and accented characters", () => {
        expect(fs.toAsciiFilename("한글")).toBe("HanGeul");
        expect(fs.toAsciiFilename("café")).toBe("cafe");
    });

    it("leaves printable ASCII unchanged", () => {
        expect(fs.toAsciiFilename("report-v1.txt")).toBe("report-v1.txt");
    });

    it("replaces remaining non-printable ASCII with underscores", () => {
        expect(fs.toAsciiFilename("a\u0000b")).toBe("a_b");
    });
});

describe("sanitizeDownloadPathSegment", () => {
    it("applies Windows sanitize with underscore by default", () => {
        expect(fs.sanitizeDownloadPathSegment("a<b>.txt", { asciiFilenames: false })).toBe(
            "a_b_.txt",
        );
    });

    it("transliterates then sanitizes when asciiFilenames is on", () => {
        expect(fs.sanitizeDownloadPathSegment("파일:이름.txt", { asciiFilenames: true })).toBe(
            "PaIl_ILeum.txt",
        );
    });

    it("falls back to Untitled for empty transliteration results", () => {
        expect(fs.sanitizeDownloadPathSegment("\u200B", { asciiFilenames: true })).toBe("Untitled");
        expect(fs.sanitizeDownloadPathSegment("", { asciiFilenames: true })).toBe("Untitled");
    });

    it("keeps collection-folder sanitize string when provided", () => {
        expect(
            fs.sanitizeDownloadPathSegment("컬렉션:이름", {
                asciiFilenames: true,
                sanitizeString: " ",
            }),
        ).toBe("KeolLegSyeon ILeum");
    });
});

describe("getSafeRelativePath", () => {
    it("sanitizes each segment without ascii conversion when disabled", () => {
        expect(fs.getSafeRelativePath("dir/a:b.txt", { asciiFilenames: false })).toBe(
            ["dir", "a_b.txt"].join(path.sep),
        );
    });

    it("converts non-ascii segments when enabled", () => {
        expect(fs.getSafeRelativePath("폴더/파일.txt", { asciiFilenames: true })).toBe(
            ["PolDeo", "PaIl.txt"].join(path.sep),
        );
    });

    it("keeps empty-after-transliteration segments as Untitled", () => {
        const relative = fs.getSafeRelativePath("keep/\u200B/file.txt", { asciiFilenames: true });
        expect(relative.split(path.sep)).toEqual(["keep", "Untitled", "file.txt"]);
    });
});
