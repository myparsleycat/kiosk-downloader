import { formatCompatShareText } from "@shared/compat-share-text";
import { describe, expect, it } from "vitest";

describe("formatCompatShareText", () => {
    it("formats ordered URLs with a stable expiration timestamp", () => {
        expect(
            formatCompatShareText({
                title: "여름 행사 자료",
                urls: ["https://kio.ac/c/first", "https://kio.ac/c/second"],
                expiresAt: Date.UTC(2026, 6, 31, 12, 34, 56),
            }),
        ).toBe(
            [
                "여름 행사 자료",
                "",
                "1/2 https://kio.ac/c/first",
                "2/2 https://kio.ac/c/second",
                "",
                "만료 시각: 2026-07-31T12:34:56.000Z",
            ].join("\n"),
        );
    });

    it("includes a common password exactly once", () => {
        const result = formatCompatShareText({
            title: "공유 자료",
            urls: ["https://kio.ac/c/first", "https://kio.ac/c/second"],
            expiresAt: 0,
            password: "open-sesame",
        });

        expect(result).toBe(
            [
                "공유 자료",
                "",
                "1/2 https://kio.ac/c/first",
                "2/2 https://kio.ac/c/second",
                "",
                "만료 시각: 1970-01-01T00:00:00.000Z",
                "비밀번호: open-sesame",
            ].join("\n"),
        );
        expect(result.match(/open-sesame/g)).toHaveLength(1);
    });

    it("rejects empty URLs", () => {
        for (const urls of [[], ["https://kio.ac/c/first", ""]]) {
            expect(() => formatCompatShareText({ title: "공유 자료", urls, expiresAt: 0 })).toThrow(
                "Compatibility share URLs must not be empty.",
            );
        }
    });
});
