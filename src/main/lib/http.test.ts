import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
    resolveProxy: vi.fn(),
    netFetch: vi.fn(),
}));
const undiciMocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    agents: [] as Array<{ close: () => Promise<void>; options: unknown }>,
    proxyAgents: [] as Array<{ close: () => Promise<void>; options: unknown }>,
}));
const socksMocks = vi.hoisted(() => ({
    dispatchers: [] as Array<{
        close: () => Promise<void>;
        options: unknown;
    }>,
}));

vi.mock("electron", () => ({
    net: { fetch: electronMocks.netFetch },
    session: { defaultSession: { resolveProxy: electronMocks.resolveProxy } },
}));

vi.mock("undici", () => {
    class Agent {
        public readonly close = vi.fn(async () => undefined);
        public readonly options: unknown;

        public constructor(options?: unknown) {
            this.options = options;
            undiciMocks.agents.push(this);
        }
    }

    class ProxyAgent {
        public readonly close = vi.fn(async () => undefined);

        public constructor(public readonly options: unknown) {
            undiciMocks.proxyAgents.push(this);
        }
    }

    return {
        Agent,
        ProxyAgent,
        Request: globalThis.Request,
        fetch: undiciMocks.fetch,
    };
});

vi.mock("fetch-socks", () => ({
    socksDispatcher: vi.fn((options: unknown) => {
        const dispatcher = { close: vi.fn(async () => undefined), options };
        socksMocks.dispatchers.push(dispatcher);
        return dispatcher;
    }),
}));

import {
    HTTP,
    ProxyResolutionError,
    TimeoutError,
    delay,
    ipv4Fetch,
    plainUndiciFetch,
} from "./http";

describe("HTTP.request", () => {
    beforeEach(() => {
        electronMocks.resolveProxy.mockReset().mockResolvedValue("DIRECT");
        electronMocks.netFetch.mockReset().mockResolvedValue(new Response());
        undiciMocks.fetch.mockReset().mockResolvedValue(new Response());
        undiciMocks.agents.length = 0;
        undiciMocks.proxyAgents.length = 0;
        socksMocks.dispatchers.length = 0;
    });

    afterEach(async () => {
        vi.useRealTimers();
        await new HTTP({} as never).destroy();
    });

    it("preserves a request-specific fetch implementation", async () => {
        const customFetch = vi.fn(async () => new Response());
        const http = new HTTP({} as never);

        await http.request("https://example.com", { fetch: customFetch });

        expect(customFetch).toHaveBeenCalledTimes(1);
        expect(electronMocks.resolveProxy).not.toHaveBeenCalled();
        expect(electronMocks.netFetch).not.toHaveBeenCalled();
    });

    it("uses the IPv4-pinned dispatcher for direct connections by default", async () => {
        electronMocks.resolveProxy.mockResolvedValue("DIRECT");
        undiciMocks.fetch.mockResolvedValue(new Response());
        const http = new HTTP({} as never);

        expect(await http.pickFetch("https://example.com", {})).toBe(ipv4Fetch);
        await ipv4Fetch("https://example.com");

        expect(undiciMocks.agents[0]?.options).toEqual({ connect: { family: 4 } });
    });

    it("uses the plain dispatcher for direct connections when IPv4 pinning is disabled", async () => {
        electronMocks.resolveProxy.mockResolvedValue("direct; DIRECT");
        undiciMocks.fetch.mockResolvedValue(new Response());
        const http = new HTTP({} as never);
        http.setForceIpv4(false);

        expect(await http.pickFetch("https://example.com", {})).toBe(plainUndiciFetch);
        await plainUndiciFetch("https://example.com");

        expect(undiciMocks.agents[0]?.options).toBeUndefined();
    });

    it("uses Chromium networking for ordinary proxied requests", async () => {
        electronMocks.resolveProxy.mockResolvedValue("PROXY proxy.example:8080; DIRECT");
        electronMocks.netFetch.mockResolvedValue(new Response("proxied"));
        const http = new HTTP({} as never);

        const response = await http.request("https://example.com", { retry: false });

        expect(await response.text()).toBe("proxied");
        expect(electronMocks.netFetch).toHaveBeenCalledTimes(1);
        expect(undiciMocks.fetch).not.toHaveBeenCalled();
    });

    it("falls back to Chromium networking when ordinary proxy resolution fails", async () => {
        electronMocks.resolveProxy.mockRejectedValue(new Error("PAC failed"));
        electronMocks.netFetch.mockResolvedValue(new Response());
        const http = new HTTP({} as never);

        await http.request("https://example.com", { retry: false });

        expect(electronMocks.netFetch).toHaveBeenCalledTimes(1);
    });

    it("falls back to Chromium networking when ordinary proxy resolution is empty", async () => {
        electronMocks.resolveProxy.mockResolvedValue("");
        electronMocks.netFetch.mockResolvedValue(new Response());
        const http = new HTTP({} as never);

        await http.request("https://example.com", { retry: false });

        expect(electronMocks.netFetch).toHaveBeenCalledTimes(1);
        expect(undiciMocks.fetch).not.toHaveBeenCalled();
    });

    it.each([
        ["PROXY proxy.example:8080", "http://proxy.example:8080"],
        ["HTTPS proxy.example:8443", "https://proxy.example:8443"],
    ])(
        "uses an HTTP proxy-aware Undici dispatcher for streaming requests: %s",
        async (result, uri) => {
            electronMocks.resolveProxy.mockResolvedValue(result);
            undiciMocks.fetch.mockResolvedValue(new Response());
            const http = new HTTP({} as never);

            const fetchImpl = await http.pickFetch("https://example.com", {
                onUploadProgress: vi.fn(),
            });
            await fetchImpl("https://example.com");

            expect(undiciMocks.proxyAgents[0]?.options).toBe(uri);
        },
    );

    it.each([
        ["SOCKS proxy.example:1080", 4],
        ["SOCKS5 proxy.example:1080", 5],
    ])("uses the correct SOCKS protocol for streaming requests: %s", async (result, type) => {
        electronMocks.resolveProxy.mockResolvedValue(result);
        const http = new HTTP({} as never);

        const fetchImpl = await http.pickFetch("https://example.com", {
            onUploadProgress: vi.fn(),
        });
        await fetchImpl("https://example.com");

        expect(socksMocks.dispatchers[0]?.options).toEqual({
            type,
            host: "proxy.example",
            port: 1080,
        });
    });

    it("uses the first supported directive for streaming requests", async () => {
        electronMocks.resolveProxy.mockResolvedValue(
            "UNKNOWN unsupported.example:1080; HTTPS proxy.example:8443; DIRECT",
        );
        undiciMocks.fetch.mockResolvedValue(new Response());
        const http = new HTTP({} as never);

        const fetchImpl = await http.pickFetch("https://example.com", {
            onUploadProgress: vi.fn(),
        });
        await fetchImpl("https://example.com");

        expect(undiciMocks.proxyAgents[0]?.options).toBe("https://proxy.example:8443");
    });

    it("uses a direct dispatcher when DIRECT is the first supported streaming directive", async () => {
        electronMocks.resolveProxy.mockResolvedValue("UNKNOWN unsupported.example:1080; DIRECT");
        const http = new HTTP({} as never);

        const fetchImpl = await http.pickFetch("https://example.com", {
            onUploadProgress: vi.fn(),
        });
        await fetchImpl("https://example.com");

        expect(undiciMocks.agents[0]?.options).toEqual({ connect: { family: 4 } });
        expect(electronMocks.netFetch).not.toHaveBeenCalled();
    });

    it("reuses cached proxy dispatchers and closes them on destroy", async () => {
        electronMocks.resolveProxy.mockResolvedValue("PROXY proxy.example:8080");
        const http = new HTTP({} as never);
        const options = { onUploadProgress: vi.fn() };

        await (
            await http.pickFetch("https://one.example", options)
        )("https://one.example");
        await (
            await http.pickFetch("https://two.example", options)
        )("https://two.example");

        expect(undiciMocks.proxyAgents).toHaveLength(1);
        await http.destroy();
        expect(undiciMocks.proxyAgents[0]?.close).toHaveBeenCalledTimes(1);
    });

    it("separates proxy dispatcher caches by the IPv4 setting", async () => {
        electronMocks.resolveProxy.mockResolvedValue("PROXY proxy.example:8080");
        const http = new HTTP({} as never);
        const options = { onUploadProgress: vi.fn() };

        await (
            await http.pickFetch("https://one.example", options)
        )("https://one.example");
        http.setForceIpv4(false);
        await (
            await http.pickFetch("https://two.example", options)
        )("https://two.example");

        expect(undiciMocks.proxyAgents).toHaveLength(2);
    });

    it.each(["", "UNKNOWN proxy.example:1080"])(
        "rejects streaming requests without a supported proxy directive: %j",
        async (result) => {
            electronMocks.resolveProxy.mockResolvedValue(result);
            const http = new HTTP({} as never);

            await expect(
                http.pickFetch("https://example.com", { onUploadProgress: vi.fn() }),
            ).rejects.toBeInstanceOf(ProxyResolutionError);
        },
    );

    it("rejects streaming requests when proxy resolution fails", async () => {
        electronMocks.resolveProxy.mockRejectedValue(new Error("PAC failed"));
        const http = new HTTP({} as never);

        await expect(
            http.pickFetch("https://example.com", { onUploadProgress: vi.fn() }),
        ).rejects.toBeInstanceOf(ProxyResolutionError);
    });

    it("forwards RequestInit through plainUndiciFetch", async () => {
        undiciMocks.fetch.mockResolvedValue(new Response());
        const controller = new AbortController();

        await plainUndiciFetch("https://example.com", {
            method: "POST",
            headers: { "X-Test": "yes" },
            body: "payload",
            signal: controller.signal,
        });

        expect(undiciMocks.fetch).toHaveBeenCalledWith(
            "https://example.com",
            expect.objectContaining({
                method: "POST",
                headers: { "X-Test": "yes" },
                body: "payload",
                signal: controller.signal,
                dispatcher: expect.anything(),
            }),
        );
    });

    it("aborts shared delay immediately", async () => {
        const controller = new AbortController();
        const pending = delay(60_000, controller.signal);

        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
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
