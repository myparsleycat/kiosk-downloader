import { describe, expect, it } from "vitest";

import { isKioskCompatiblePath } from "./upload-path";

describe("isKioskCompatiblePath", () => {
    it("accepts a simple relative path with normal segments", () => {
        expect(isKioskCompatiblePath("dir/file.txt")).toBe(true);
    });

    it("accepts nested directories and unicode names", () => {
        expect(isKioskCompatiblePath("a/b/c/사진 한장.jpg")).toBe(true);
    });

    it("accepts a single file with no directory", () => {
        expect(isKioskCompatiblePath("file.bin")).toBe(true);
    });

    it("rejects a path containing a '.' segment", () => {
        expect(isKioskCompatiblePath("dir/./file.txt")).toBe(false);
    });

    it("rejects a path containing a '..' segment", () => {
        expect(isKioskCompatiblePath("../escape/file.txt")).toBe(false);
        expect(isKioskCompatiblePath("a/b/../../c")).toBe(false);
    });

    it("rejects segments containing invalid filename characters", () => {
        for (const bad of ["a/b\\c", "a:b", 'a"b', "a<b>", "a|b", "a*b?", "a/b/c:d"]) {
            expect(isKioskCompatiblePath(bad), bad).toBe(false);
        }
    });

    it("rejects a control character in any segment", () => {
        expect(isKioskCompatiblePath("a\u0000b/file.txt")).toBe(false);
        expect(isKioskCompatiblePath("ok/\u001F")).toBe(false);
    });

    it("rejects an empty segment", () => {
        expect(isKioskCompatiblePath("a//b")).toBe(false);
    });

    it("rejects a path whose only segment is whitespace", () => {
        expect(isKioskCompatiblePath("   ")).toBe(false);
    });
});
