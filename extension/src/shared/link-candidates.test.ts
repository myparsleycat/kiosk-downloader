import { describe, expect, it } from "vitest";

import { type CandidateFilter, findHrefCandidate, findTextCandidates } from "./link-candidates";

const MEGA_URL = `https://mega.nz/file/abcdefgh#${"A".repeat(43)}`;
const KIOSK_URL = "https://kio.ac/c/aAbBcCdDeEfFgGhHiIjJkK";

const filter: CandidateFilter = {
    providers: { kiosk: true, transfer: true, workupload: true, mega: true, direct: true },
    directExtensions: ["zip", "mp4"],
    decodeLinks: true,
};

const base64 = (value: string) => Buffer.from(value).toString("base64");
const base64Url = (value: string) => Buffer.from(value).toString("base64url");

describe("findHrefCandidate", () => {
    it("decodes nested base64 carried in a redirect parameter", () => {
        const href = `https://forum.example/go?to=${encodeURIComponent(base64(base64(MEGA_URL)))}`;
        expect(findHrefCandidate(href, filter)).toEqual({ url: MEGA_URL, provider: "mega" });
    });

    it("decodes URL-safe base64 in a path segment", () => {
        const href = `https://forum.example/out/${base64Url(MEGA_URL)}`;
        expect(findHrefCandidate(href, filter)?.url).toBe(MEGA_URL);
    });

    it("finds a percent-encoded share link in a redirect parameter", () => {
        const href = `https://forum.example/redirect?url=${encodeURIComponent(MEGA_URL)}`;
        expect(findHrefCandidate(href, filter)?.url).toBe(MEGA_URL);
    });

    it("ignores ordinary page links but accepts listed file extensions", () => {
        expect(findHrefCandidate("https://site.example/board/view?id=123", filter)).toBeNull();
        expect(findHrefCandidate("https://cdn.example/files/movie.MP4", filter)).toEqual({
            url: "https://cdn.example/files/movie.MP4",
            provider: "direct",
        });
    });

    it("applies the extension rule to encoded direct URLs", () => {
        const page = `https://forum.example/go?u=${base64("https://gofile.io/d/Gj0tkadf")}`;
        expect(findHrefCandidate(page, filter)).toBeNull();
        const file = `https://forum.example/go?u=${base64("https://cdn.example/a.zip")}`;
        expect(findHrefCandidate(file, filter)?.url).toBe("https://cdn.example/a.zip");
    });

    it("respects disabled providers and the decode switch", () => {
        const href = `https://forum.example/go?to=${base64(MEGA_URL)}`;
        expect(
            findHrefCandidate(href, { ...filter, providers: { ...filter.providers, mega: false } }),
        ).toBeNull();
        expect(findHrefCandidate(href, { ...filter, decodeLinks: false })).toBeNull();
    });
});

describe("findTextCandidates", () => {
    it("reports where each encoded link ends in the text", () => {
        const encoded = base64(KIOSK_URL);
        const text = `링크: ${encoded} 비번은 댓글`;
        expect(findTextCandidates(text, filter)).toEqual([
            {
                end: text.indexOf(encoded) + encoded.length,
                candidate: { url: KIOSK_URL, provider: "kiosk" },
            },
        ]);
    });

    it("does not treat long words or non-link base64 as links", () => {
        const text = [
            "ConfigurationManagerFactoryBuilder",
            base64("just some plain sentence here"),
            base64("https://gofile.io/d/Gj0tkadf"),
        ].join(" ");
        expect(findTextCandidates(text, filter)).toEqual([]);
    });
});
