import { describe, expect, it } from "vitest";

import { matchesHost, parseHostListInput } from "./settings";

describe("parseHostListInput", () => {
    it("reduces URLs and host entries to deduplicated hostname patterns", () => {
        expect(
            parseHostListInput(
                "https://Kio.ac/path?x, kio.ac:8080 user@example.com\n.example.org. *.한국.kr bad host, *",
            ),
        ).toEqual([
            "kio.ac",
            "example.com",
            "example.org",
            "*.xn--3e0b707e.kr",
            "bad",
            "host",
            "*",
        ]);
    });
});

describe("matchesHost", () => {
    it.each([
        ["kio.ac", "kio.ac", true],
        ["cdn.kio.ac", "kio.ac", true],
        ["evilkio.ac", "kio.ac", false],
        ["kioxac", "kio.ac", false],
        ["kio.ac", "*.kio.ac", true],
        ["a.b.kio.ac", "*.kio.ac", true],
        ["example.co.uk", "example.*", true],
        ["cdn.example.com", "example.*", true],
        ["myexample.com", "example.*", false],
        ["cdn12.example.net", "cdn*.example.net", true],
        ["www.example.net", "cdn*.example.net", false],
        ["anything.test", "*", true],
    ])("%s against %s is %s", (hostname, pattern, expected) => {
        expect(matchesHost(hostname, [pattern])).toBe(expected);
    });
});
