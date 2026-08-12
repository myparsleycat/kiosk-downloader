import { afterEach, describe, expect, it, vi } from "vitest";

import { HTTP, TimeoutError } from "./http";

describe("HTTP.request", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("preserves a request-specific fetch implementation", async () => {
        const customFetch = vi.fn(async () => new Response());
        const http = new HTTP({} as never);

        await http.request("https://example.com", { fetch: customFetch });

        expect(customFetch).toHaveBeenCalledTimes(1);
    });

    it("defaults to the IPv4-pinned undici fetch", async () => {
        const http = new HTTP({} as never);

        expect(http.pickFetch({})).toBeDefined();
    });

    it("merges the default User-Agent header with request headers", async () => {
        const customFetch = vi.fn(async (_input: RequestInfo | URL) => new Response());
        const http = new HTTP({} as never);

        await http.request("https://example.com", {
            headers: { "X-Custom": "yes" },
            fetch: customFetch,
        });

        const request = customFetch.mock.calls[0]?.[0] as Request | undefined;
        expect(request?.headers.get("user-agent")).toContain("Chrome/");
        expect(request?.headers.get("x-custom")).toBe("yes");
    });

    it("retries network errors up to the default limit", async () => {
        const customFetch = vi
            .fn()
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockResolvedValueOnce(new Response("ok"));
        const http = new HTTP({} as never);

        const response = await http.request("https://example.com", { fetch: customFetch });

        expect(response.status).toBe(200);
        expect(customFetch).toHaveBeenCalledTimes(2);
    });

    it("stops retrying after the limit and rethrows the network error", async () => {
        const customFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
        const http = new HTTP({} as never);

        await expect(
            http.request("https://example.com", { retry: { limit: 1 }, fetch: customFetch }),
        ).rejects.toThrow("fetch failed");
        expect(customFetch).toHaveBeenCalledTimes(2);
    });

    it("does not retry POST requests", async () => {
        const customFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
        const http = new HTTP({} as never);

        await expect(
            http.request("https://example.com", { method: "POST", fetch: customFetch }),
        ).rejects.toThrow("fetch failed");
        expect(customFetch).toHaveBeenCalledTimes(1);
    });

    it("does not retry non-network errors", async () => {
        const customFetch = vi.fn().mockRejectedValue(new Error("boom"));
        const http = new HTTP({} as never);

        await expect(http.request("https://example.com", { fetch: customFetch })).rejects.toThrow(
            "boom",
        );
        expect(customFetch).toHaveBeenCalledTimes(1);
    });

    it("does not retry when retry is disabled", async () => {
        const customFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
        const http = new HTTP({} as never);

        await expect(
            http.request("https://example.com", { retry: 0, fetch: customFetch }),
        ).rejects.toThrow("fetch failed");
        expect(customFetch).toHaveBeenCalledTimes(1);
    });

    it("throws TimeoutError when response headers do not arrive in time", async () => {
        vi.useFakeTimers();
        const customFetch = vi.fn(
            () => new Promise<Response>(() => undefined),
        ) as unknown as typeof fetch;
        const http = new HTTP({} as never);

        const pending = expect(
            http.request("https://example.com", { timeout: 1_000, fetch: customFetch }),
        ).rejects.toBeInstanceOf(TimeoutError);
        await vi.advanceTimersByTimeAsync(1_000);

        await pending;
    });

    it("aborts the underlying fetch on timeout", async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        const customFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            signal = input instanceof Request ? input.signal : (init?.signal ?? undefined);
            return new Promise<Response>(() => undefined);
        }) as unknown as typeof fetch;
        const http = new HTTP({} as never);

        const pending = expect(
            http.request("https://example.com", { timeout: 1_000, fetch: customFetch }),
        ).rejects.toBeInstanceOf(TimeoutError);
        await vi.advanceTimersByTimeAsync(1_000);

        await pending;
        expect(signal?.aborted).toBe(true);
    });

    it("does not time out when timeout is disabled", async () => {
        const customFetch = vi.fn(async () => new Response("ok"));
        const http = new HTTP({} as never);

        const response = await http.request("https://example.com", {
            timeout: false,
            fetch: customFetch,
        });

        expect(response.status).toBe(200);
    });

    it("reports upload progress with transferred bytes and percent", async () => {
        const progress: Array<{ percent: number; transferredBytes: number; totalBytes: number }> =
            [];
        const customFetch = vi.fn(async (input: RequestInfo | URL) => {
            const request = input instanceof Request ? input : new Request(input);
            await request.body?.pipeTo(new WritableStream());
            return new Response("ok");
        });
        const http = new HTTP({} as never);

        await http.request("https://example.com", {
            method: "PUT",
            body: "hello world",
            onUploadProgress: (p) => progress.push(p),
            fetch: customFetch,
        });

        expect(progress.length).toBeGreaterThan(0);
        const last = progress[progress.length - 1];
        expect(last.transferredBytes).toBe(11);
        expect(last.totalBytes).toBe(11);
        expect(last.percent).toBe(1);
    });

    it("pins Content-Length for fixed-size bodies so undici does not send them chunked", async () => {
        let seenRequest: Request | undefined;
        const customFetch = vi.fn((input: RequestInfo | URL) => {
            seenRequest = input instanceof Request ? input : new Request(input);
            return Promise.resolve(new Response("ok"));
        });
        const http = new HTTP({} as never);

        await http.request("https://example.com", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ captcha: "9094 4194 6583 " }),
            fetch: customFetch,
        });

        expect(seenRequest?.headers.get("content-length")).toBe("23");
    });

    it("does not pin Content-Length when the caller already set it", async () => {
        let seenRequest: Request | undefined;
        const customFetch = vi.fn((input: RequestInfo | URL) => {
            seenRequest = input instanceof Request ? input : new Request(input);
            return Promise.resolve(new Response("ok"));
        });
        const http = new HTTP({} as never);

        await http.request("https://example.com", {
            method: "POST",
            body: "short",
            headers: { "Content-Length": "5" },
            fetch: customFetch,
        });

        expect(seenRequest?.headers.get("content-length")).toBe("5");
    });
});
