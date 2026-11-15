import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { HTTP, plainUndiciFetch } from "../../lib/http";
import {
    DIRECT_CHUNK_SIZE,
    DirectHttpClient,
    hasDirectRemoteChanged,
    resolveDirectFilename,
} from "./direct-http-client";

function createClient(payloadRequest: ReturnType<typeof vi.fn>) {
    return new DirectHttpClient({
        http: { payloadRequest },
        lib: { fs: { sanitizeDownloadPathSegment: (name: string) => name } },
    } as never);
}

function requestHeaders(call: unknown[]) {
    return new Headers((call[1] as { headers: HeadersInit }).headers);
}

describe("DirectHttpClient.probe", () => {
    it("detects Range support, size and validators from a 206 probe", async () => {
        const payloadRequest = vi.fn(
            async () =>
                new Response("x", {
                    status: 206,
                    headers: {
                        "content-range": "bytes 0-0/12345",
                        etag: '"abc"',
                        "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
                    },
                }),
        );
        const probe = await createClient(payloadRequest).probe(
            "https://example.com/a.bin",
            undefined,
        );

        expect(probe).toMatchObject({
            size: 12345,
            rangeSupported: true,
            finalUrl: "https://example.com/a.bin",
            etag: '"abc"',
        });
        const headers = requestHeaders(payloadRequest.mock.calls[0]!);
        expect(headers.get("range")).toBe("bytes=0-0");
        expect(headers.get("accept-encoding")).toBe("identity");
        const defaults = await new HTTP({} as never).getHeaders("https://example.com/a.bin");
        const chromeVersion = /Chrome\/(\d+)/.exec(defaults["User-Agent"])?.[1];
        expect(chromeVersion).toBeDefined();
        expect(headers.get("sec-ch-ua")).toContain(`"Chromium";v="${chromeVersion}"`);
        expect(headers.get("sec-ch-ua")).toContain(`"Google Chrome";v="${chromeVersion}"`);
        expect(headers.get("sec-ch-ua-mobile")).toBe("?0");
        expect(headers.get("sec-ch-ua-platform")).toBe('"Windows"');
    });

    it.each([
        { url: "http://example.com/a.bin", userAgent: undefined },
        { url: "https://example.com/a.bin", userAgent: "custom/1.0" },
    ])("omits default Client Hints for $url with UA $userAgent", async ({ url, userAgent }) => {
        const payloadRequest = vi.fn(async () => new Response("x"));
        await createClient(payloadRequest).open(url, {
            headers: { userAgent, referer: "https://example.com/page" },
        });

        const headers = requestHeaders(payloadRequest.mock.calls[0]!);
        expect(headers.has("sec-ch-ua")).toBe(false);
        expect(headers.has("sec-ch-ua-mobile")).toBe(false);
        expect(headers.has("sec-ch-ua-platform")).toBe(false);
        expect(headers.get("user-agent")).toBe(userAgent ?? null);
        expect(headers.get("referer")).toBe("https://example.com/page");
        expect(headers.has("sec-fetch-site")).toBe(false);
    });

    it("rebuilds Client Hints for each redirect's protocol", async () => {
        const payloadRequest = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { location: "http://example.com/file" },
                }),
            )
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { location: "https://cdn.example.com/file" },
                }),
            )
            .mockResolvedValueOnce(new Response("x"));
        await createClient(payloadRequest).open("https://example.com/start", {});

        expect(
            payloadRequest.mock.calls.map((call) => requestHeaders(call).has("sec-ch-ua")),
        ).toEqual([true, false, true]);
    });

    it("sends the fetch profile through the real Undici transport", async () => {
        const server = createServer((request, response) => {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(request.headers));
        });
        const http = new HTTP({} as never);
        const payloadRequest = vi.fn(
            (url: string, options: Parameters<HTTP["payloadRequest"]>[1]) =>
                http.payloadRequest(url, { ...options, fetch: plainUndiciFetch }),
        );

        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Expected a TCP address");
            const opened = await createClient(payloadRequest).open(
                `http://127.0.0.1:${address.port}/file`,
                { range: "bytes=0-0", ifRange: '"v1"' },
            );
            const headers = (await opened.response.json()) as Record<string, string>;
            expect(headers["user-agent"]).toMatch(/Chrome\/\d+/);
            expect(headers["accept"]).toBe("*/*");
            expect(headers["accept-language"]).toBe("ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7");
            expect(headers["sec-fetch-dest"]).toBe("empty");
            expect(headers["sec-fetch-mode"]).toBe("cors");
            expect(headers["sec-fetch-site"]).toBeUndefined();
            expect(headers["range"]).toBe("bytes=0-0");
            expect(headers["if-range"]).toBe('"v1"');
            expect(headers["accept-encoding"].split(",").map((value) => value.trim())).toEqual(
                expect.arrayContaining(["identity"]),
            );
            expect(headers["accept-encoding"]).not.toMatch(/gzip|deflate|br|zstd/);
        } finally {
            await http.destroy();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });

    it("falls back to a single stream when the server ignores Range", async () => {
        const payloadRequest = vi.fn(
            async () =>
                new Response("full body", { status: 200, headers: { "content-length": "9" } }),
        );
        await expect(
            createClient(payloadRequest).probe("https://example.com/a.bin", undefined),
        ).resolves.toMatchObject({ size: 9, rangeSupported: false });
    });

    it("accepts an empty file reported through 416", async () => {
        const payloadRequest = vi.fn(
            async () =>
                new Response("<html>416</html>", {
                    status: 416,
                    headers: { "content-range": "bytes */0", "content-type": "text/html" },
                }),
        );
        await expect(
            createClient(payloadRequest).probe("https://example.com/empty", undefined),
        ).resolves.toMatchObject({ size: 0, rangeSupported: true });
    });

    it("rejects responses without a known size or with compression", async () => {
        const unknown = vi.fn(
            async () =>
                new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/*" } }),
        );
        await expect(
            createClient(unknown).probe("https://example.com/a", undefined),
        ).rejects.toThrow("파일 크기");

        const gzip = vi.fn(
            async () =>
                new Response("x", {
                    status: 200,
                    headers: { "content-length": "1", "content-encoding": "gzip" },
                }),
        );
        await expect(createClient(gzip).probe("https://example.com/a", undefined)).rejects.toThrow(
            "gzip",
        );
    });

    it("rejects web pages unless the server attaches or names the file", async () => {
        const page = (headers: Record<string, string>) =>
            vi.fn(
                async () =>
                    new Response("<html>", {
                        status: 200,
                        headers: {
                            "content-type": "text/html; charset=utf-8",
                            "content-length": "6",
                            ...headers,
                        },
                    }),
            );
        await expect(
            createClient(page({})).probe("https://example.com/d/abc", undefined),
        ).rejects.toThrow("웹 페이지");
        await expect(
            createClient(page({ "content-disposition": 'attachment; filename="page.html"' })).probe(
                "https://example.com/page.html",
                undefined,
            ),
        ).resolves.toMatchObject({ size: 6 });
        await expect(
            createClient(page({ "content-disposition": 'inline; filename="a.zip"' })).probe(
                "https://example.com/get.php",
                undefined,
            ),
        ).resolves.toMatchObject({ size: 6 });
    });

    it("follows redirects and drops the cookie once the origin changes", async () => {
        const payloadRequest = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, { status: 302, headers: { location: "/next" } }),
            )
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { location: "https://cdn.example.net/signed?sig=1" },
                }),
            )
            .mockResolvedValueOnce(
                new Response("x", {
                    status: 206,
                    headers: { "content-range": "bytes 0-0/10" },
                }),
            );
        const probe = await createClient(payloadRequest).probe("https://example.com/start", {
            cookie: "session=1",
            referer: "https://example.com/page",
        });

        expect(probe.finalUrl).toBe("https://cdn.example.net/signed?sig=1");
        expect(payloadRequest.mock.calls.map((call) => call[0])).toEqual([
            "https://example.com/start",
            "https://example.com/next",
            "https://cdn.example.net/signed?sig=1",
        ]);
        const cookies = payloadRequest.mock.calls.map((call) => requestHeaders(call).get("cookie"));
        expect(cookies).toEqual(["session=1", "session=1", null]);
        expect(requestHeaders(payloadRequest.mock.calls[2]!).get("referer")).toBe(
            "https://example.com/page",
        );
    });

    it("re-decodes a raw UTF-8 Location header before following it", async () => {
        const rawLocation = Buffer.from("/다운로드/파일.zip", "utf8").toString("latin1");
        const payloadRequest = vi
            .fn()
            .mockResolvedValueOnce({
                status: 302,
                headers: new Headers({ location: rawLocation }),
                body: null,
            })
            .mockResolvedValueOnce(
                new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/1" } }),
            );
        const probe = await createClient(payloadRequest).probe("https://example.com/a", undefined);

        expect(probe.finalUrl).toBe(
            "https://example.com/%EB%8B%A4%EC%9A%B4%EB%A1%9C%EB%93%9C/%ED%8C%8C%EC%9D%BC.zip",
        );
    });

    it("scopes the cookie to the given origin instead of the first requested URL", async () => {
        const payloadRequest = vi.fn(
            async () =>
                new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/1" } }),
        );
        await createClient(payloadRequest).open("https://cdn.example.net/signed", {
            headers: { cookie: "session=1" },
            cookieOriginUrl: "https://example.com/start",
        });

        expect(requestHeaders(payloadRequest.mock.calls[0]!).get("cookie")).toBeNull();
    });

    it("surfaces HTTP errors with their status", async () => {
        const payloadRequest = vi.fn(async () => new Response("denied", { status: 403 }));
        await expect(
            createClient(payloadRequest).probe("https://example.com/a", undefined),
        ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("HTTP 403") });
    });
});

describe("DirectHttpClient.loadCollection", () => {
    it("builds a single-file collection named from the response", async () => {
        const payloadRequest = vi.fn(
            async () =>
                new Response("x", {
                    status: 206,
                    headers: {
                        "content-range": "bytes 0-0/100",
                        "content-disposition":
                            "attachment; filename*=UTF-8''%ED%95%9C%EA%B8%80.zip",
                    },
                }),
        );
        const loaded = await createClient(payloadRequest).loadCollection(
            { url: "https://example.com/download?id=1", headers: { referer: "https://x.test/" } },
            false,
        );

        expect(loaded).toMatchObject({
            provider: "direct",
            requestHeaders: { referer: "https://x.test/" },
            fileMeta: { rangeSupported: true, finalUrl: "https://example.com/download?id=1" },
            collection: {
                shareId: "example.com",
                name: "한글.zip",
                segmentSize: DIRECT_CHUNK_SIZE,
                provider: "direct",
            },
        });
        expect(loaded.collection.tree.entries).toEqual([
            {
                kind: "file",
                node: { type: "file", id: loaded.rootId, name: "한글.zip", size: 100 },
            },
        ]);
    });
});

describe("resolveDirectFilename", () => {
    const url = "https://example.com/files/report%20final.pdf?x=1";

    it("prefers filename* over filename", () => {
        expect(
            resolveDirectFilename(
                `attachment; filename="fallback.txt"; filename*=UTF-8''na%C3%AFve.txt`,
                url,
                url,
            ),
        ).toBe("naïve.txt");
    });

    it("unquotes filename and repairs UTF-8 delivered as Latin-1", () => {
        expect(resolveDirectFilename('attachment; filename="a \\"b\\".txt"', url, url)).toBe(
            'a "b".txt',
        );
        const mojibake = Buffer.from("자료.zip", "utf8").toString("latin1");
        expect(resolveDirectFilename(`attachment; filename="${mojibake}"`, url, url)).toBe(
            "자료.zip",
        );
    });

    it("tolerates a quoted filename* and percent-encoded plain filenames", () => {
        expect(resolveDirectFilename(`attachment; filename*="UTF-8''report.pdf"`, url, url)).toBe(
            "report.pdf",
        );
        expect(resolveDirectFilename('attachment; filename="%ED%95%9C.zip"', url, url)).toBe(
            "한.zip",
        );
        expect(
            resolveDirectFilename(
                `attachment; filename*=UTF-8''%2F; filename="good.zip"`,
                url,
                url,
            ),
        ).toBe("good.zip");
    });

    it("strips directories from header filenames", () => {
        expect(resolveDirectFilename('attachment; filename="../../etc/passwd"', url, url)).toBe(
            "passwd",
        );
    });

    it("falls back to the final URL, the source URL, then a default", () => {
        expect(resolveDirectFilename(null, url, url)).toBe("report final.pdf");
        expect(resolveDirectFilename(null, "https://cdn.test/", url)).toBe("report final.pdf");
        expect(resolveDirectFilename(null, "https://cdn.test/", "https://example.com/")).toBe(
            "download",
        );
    });
});

describe("hasDirectRemoteChanged", () => {
    const probe = {
        size: 10,
        rangeSupported: true,
        finalUrl: "https://example.com/a",
        etag: '"v1"',
        lastModified: "Mon",
        contentDisposition: null,
    };

    it("compares size, Range support and validators", () => {
        const stored = { size: 10, rangeSupported: true, etag: '"v1"', lastModified: "Mon" };
        expect(hasDirectRemoteChanged(stored, probe)).toBe(false);
        expect(hasDirectRemoteChanged({ ...stored, size: 11 }, probe)).toBe(true);
        expect(hasDirectRemoteChanged({ ...stored, etag: '"v2"' }, probe)).toBe(true);
        expect(
            hasDirectRemoteChanged(
                { size: 10, rangeSupported: true, lastModified: "Tue" },
                { ...probe, etag: undefined },
            ),
        ).toBe(true);
    });
});
