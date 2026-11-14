import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { buildDirectRequestHeaders } from "./request-headers";

beforeEach(() => {
    vi.stubGlobal("chrome", { cookies: { getAll: vi.fn(async () => []) } });
    vi.stubGlobal("navigator", { userAgent: "Kioex Test" });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it.each([
    [
        "https://user:pass@files.example/page?q=1#access_token=SECRET",
        "https://files.example/a.zip",
        "https://files.example/page?q=1",
    ],
    [
        "https://portal.example/private?id=1#access_token=SECRET",
        "https://cdn.example/a.zip",
        "https://portal.example/",
    ],
    ["https://portal.example/private", "http://cdn.example/a.zip", undefined],
    ["chrome-extension://abc/page.html", "https://cdn.example/a.zip", undefined],
])(
    "sends only the referrer a default-policy page would send: %s -> %s",
    async (page, url, referer) => {
        expect((await buildDirectRequestHeaders(url, page)).referer).toBe(referer);
    },
);
