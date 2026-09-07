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

import { HTTP, ProxyResolutionError, TimeoutError, delay, plainUndiciFetch } from "./http";

describe("HTTP transports", () => {
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

    it.each(["controlRequest", "payloadRequest"] as const)(
        "%s preserves a request-specific fetch implementation",
        async (method) => {
            const customFetch = vi.fn(async () => new Response());
            const http = new HTTP({} as never);

            await http[method]("https://example.com", { fetch: customFetch });

            expect(customFetch).toHaveBeenCalledTimes(1);
            expect(electronMocks.resolveProxy).not.toHaveBeenCalled();
            expect(electronMocks.netFetch).not.toHaveBeenCalled();
            expect(undiciMocks.fetch).not.toHaveBeenCalled();
        },
    );

    it("uses the IPv4-pinned dispatcher for direct control requests by default", async () => {
        const http = new HTTP({} as never);

        await http.controlRequest("https://example.com");

        expect(undiciMocks.agents[0]?.options).toEqual({ connect: { family: 4 } });
        expect(undiciMocks.fetch).toHaveBeenCalledTimes(1);
    });

    it("uses the plain dispatcher for direct control requests when IPv4 pinning is disabled", async () => {
        electronMocks.resolveProxy.mockResolvedValue("direct; DIRECT");
        const http = new HTTP({} as never);
        http.setForceIpv4(false);

        await http.controlRequest("https://example.com");

        expect(undiciMocks.agents[0]?.options).toBeUndefined();
    });

    it("uses Chromium networking for proxied control requests", async () => {
        electronMocks.resolveProxy.mockResolvedValue("PROXY proxy.example:8080; DIRECT");
        electronMocks.netFetch.mockResolvedValue(new Response("proxied"));
        const http = new HTTP({} as never);

        const response = await http.controlRequest("https://example.com");

        expect(await response.text()).toBe("proxied");
        expect(electronMocks.netFetch).toHaveBeenCalledTimes(1);
        expect(undiciMocks.fetch).not.toHaveBeenCalled();
    });

    it.each(["failure", "empty"] as const)(
        "falls back to Chromium networking when control proxy resolution is %s",
        async (result) => {
            if (result === "failure") {
                electronMocks.resolveProxy.mockRejectedValue(new Error("PAC failed"));
            } else {
                electronMocks.resolveProxy.mockResolvedValue("");
            }
            const http = new HTTP({} as never);

            await http.controlRequest("https://example.com");

            expect(electronMocks.netFetch).toHaveBeenCalledTimes(1);
            expect(undiciMocks.fetch).not.toHaveBeenCalled();
        },
    );

    it.each([
        ["PROXY proxy.example:8080", "http://proxy.example:8080"],
        ["HTTPS proxy.example:8443", "https://proxy.example:8443"],
    ])("uses an HTTP proxy-aware dispatcher for payload requests: %s", async (result, uri) => {
        electronMocks.resolveProxy.mockResolvedValue(result);
        const http = new HTTP({} as never);

        await http.payloadRequest("https://example.com");

        expect(undiciMocks.proxyAgents[0]?.options).toBe(uri);
        expect(undiciMocks.fetch).toHaveBeenCalledTimes(1);
        expect(electronMocks.netFetch).not.toHaveBeenCalled();
    });

    it.each([
        ["SOCKS proxy.example:1080", 4],
        ["SOCKS5 proxy.example:1080", 5],
    ])("uses the correct SOCKS protocol for payload requests: %s", async (result, type) => {
        electronMocks.resolveProxy.mockResolvedValue(result);
        const http = new HTTP({} as never);

        await http.payloadRequest("https://example.com");

        expect(socksMocks.dispatchers[0]?.options).toEqual({
            type,
            host: "proxy.example",
            port: 1080,
        });
    });

    it("uses the first supported proxy directive for payload requests", async () => {
        electronMocks.resolveProxy.mockResolvedValue(
            "UNKNOWN unsupported.example:1080; HTTPS proxy.example:8443; DIRECT",
        );
        const http = new HTTP({} as never);

        await http.payloadRequest("https://example.com");

        expect(undiciMocks.proxyAgents[0]?.options).toBe("https://proxy.example:8443");
    });

    it("uses an Undici direct dispatcher for direct payload requests", async () => {
        electronMocks.resolveProxy.mockResolvedValue("UNKNOWN unsupported.example:1080; DIRECT");
        const http = new HTTP({} as never);

        await http.payloadRequest("https://example.com");

        expect(undiciMocks.agents[0]?.options).toEqual({ connect: { family: 4 } });
        expect(electronMocks.netFetch).not.toHaveBeenCalled();
    });

    it("reuses cached payload proxy dispatchers and closes them on destroy", async () => {
        electronMocks.resolveProxy.mockResolvedValue("PROXY proxy.example:8080");
        const http = new HTTP({} as never);

        await http.payloadRequest("https://one.example");
        await http.payloadRequest("https://two.example");

        expect(undiciMocks.proxyAgents).toHaveLength(1);
        await http.destroy();
        expect(undiciMocks.proxyAgents[0]?.close).toHaveBeenCalledTimes(1);
    });

    it("separates proxy dispatcher caches by the IPv4 setting", async () => {
        electronMocks.resolveProxy.mockResolvedValue("PROXY proxy.example:8080");
        const http = new HTTP({} as never);

        await http.payloadRequest("https://one.example");
        http.setForceIpv4(false);
        await http.payloadRequest("https://two.example");

        expect(undiciMocks.proxyAgents).toHaveLength(2);
    });

    it.each(["", "UNKNOWN proxy.example:1080"])(
        "rejects payload requests without a supported proxy directive: %j",
        async (result) => {
            electronMocks.resolveProxy.mockResolvedValue(result);
            const http = new HTTP({} as never);

            await expect(http.payloadRequest("https://example.com")).rejects.toBeInstanceOf(
                ProxyResolutionError,
            );
        },
    );

    it("rejects payload requests when proxy resolution fails", async () => {
        electronMocks.resolveProxy.mockRejectedValue(new Error("PAC failed"));
        const http = new HTTP({} as never);

        await expect(http.payloadRequest("https://example.com")).rejects.toBeInstanceOf(
            ProxyResolutionError,
        );
    });

    it("forwards RequestInit through plainUndiciFetch", async () => {
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

    it.each(["controlRequest", "payloadRequest"] as const)(
        "%s merges headers and performs exactly one attempt",
        async (method) => {
            const customFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
            const http = new HTTP({} as never);

            await expect(
                http[method]("https://example.com", {
                    headers: { "X-Custom": "yes" },
                    fetch: customFetch,
                }),
            ).rejects.toThrow("fetch failed");

            expect(customFetch).toHaveBeenCalledTimes(1);
            const request = customFetch.mock.calls[0]?.[0] as Request | undefined;
            expect(request?.headers.get("user-agent")).toContain("Chrome/");
            expect(request?.headers.get("x-custom")).toBe("yes");
        },
    );

    it.each(["controlRequest", "payloadRequest"] as const)(
        "%s throws TimeoutError and aborts the underlying fetch",
        async (method) => {
            vi.useFakeTimers();
            let signal: AbortSignal | undefined;
            const customFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
                signal = input instanceof Request ? input.signal : (init?.signal ?? undefined);
                return new Promise<Response>(() => undefined);
            }) as unknown as typeof fetch;
            const http = new HTTP({} as never);

            const pending = expect(
                http[method]("https://example.com", { timeout: 1_000, fetch: customFetch }),
            ).rejects.toBeInstanceOf(TimeoutError);
            await vi.advanceTimersByTimeAsync(1_000);

            await pending;
            expect(signal?.aborted).toBe(true);
        },
    );

    it("does not time out when timeout is disabled", async () => {
        const customFetch = vi.fn(async () => new Response("ok"));
        const http = new HTTP({} as never);

        const response = await http.payloadRequest("https://example.com", {
            timeout: false,
            fetch: customFetch,
        });

        expect(response.status).toBe(200);
    });

    it.each([false, true])(
        "bounds control body consumption even when bytes dribble (%s)",
        async (dribble) => {
            vi.useFakeTimers();
            let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
            let request: Request | undefined;
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    bodyController = controller;
                },
            });
            const http = new HTTP({} as never);
            const pending = expect(
                http.consumeControlResponse(
                    "https://example.com",
                    {
                        timeout: 1_000,
                        fetch: vi.fn(async (input) => {
                            request = input as Request;
                            return new Response(body);
                        }),
                    },
                    (response) => response.text(),
                ),
            ).rejects.toBeInstanceOf(TimeoutError);
            await vi.advanceTimersByTimeAsync(500);
            if (dribble) bodyController?.enqueue(new TextEncoder().encode("partial"));
            await vi.advanceTimersByTimeAsync(500);
            await pending;
            expect(request?.signal.aborted).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
            bodyController?.close();
        },
    );

    it("omits query secrets from control deadline errors", async () => {
        vi.useFakeTimers();
        const http = new HTTP({} as never);
        const pending = expect(
            http.consumeControlResponse(
                "https://example.com/control?pw=secret#token",
                { timeout: 1, fetch: vi.fn(() => new Promise<Response>(() => undefined)) },
                (response) => response.text(),
            ),
        ).rejects.toMatchObject({
            name: "TimeoutError",
            message: "Request timed out: GET https://example.com/control",
        });
        await vi.advanceTimersByTimeAsync(1);
        await pending;
    });

    it("uses the default deadline for complete control responses", async () => {
        vi.useFakeTimers();
        const http = new HTTP({} as never);
        const pending = expect(
            http.consumeControlResponse(
                "https://example.com",
                {
                    fetch: vi.fn(() => new Promise<Response>(() => undefined)),
                },
                (response) => response.text(),
            ),
        ).rejects.toBeInstanceOf(TimeoutError);
        await vi.advanceTimersByTimeAsync(100_000);
        await pending;
        expect(vi.getTimerCount()).toBe(0);
    });

    it("aborts a slow consumer promptly and removes the caller listener", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, "removeEventListener");
        const reason = new Error("paused");
        const cancel = vi.fn();
        const consume = vi.fn(() => new Promise<string>(() => undefined));
        const http = new HTTP({} as never);
        const pending = expect(
            http.consumeControlResponse(
                "https://example.com",
                {
                    signal: controller.signal,
                    fetch: vi.fn(async () => new Response(new ReadableStream({ cancel }))),
                },
                consume,
            ),
        ).rejects.toBe(reason);
        await vi.advanceTimersByTimeAsync(0);
        expect(consume).toHaveBeenCalledOnce();
        controller.abort(reason);
        await pending;
        expect(cancel).toHaveBeenCalledOnce();
        expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels a late response without invoking its consumer after abort", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const response = Promise.withResolvers<Response>();
        const cancel = vi.fn();
        const consume = vi.fn(async () => "unexpected");
        const http = new HTTP({} as never);
        const pending = expect(
            http.consumeControlResponse(
                "https://example.com",
                {
                    signal: controller.signal,
                    fetch: vi.fn(() => response.promise),
                },
                consume,
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await pending;
        response.resolve(new Response(new ReadableStream({ cancel })));
        await vi.advanceTimersByTimeAsync(0);
        expect(consume).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("does not start an already aborted control request", async () => {
        const controller = new AbortController();
        const reason = new Error("paused");
        controller.abort(reason);
        const fetch = vi.fn();
        const consume = vi.fn();
        await expect(
            new HTTP({} as never).consumeControlResponse(
                "https://example.com",
                {
                    signal: controller.signal,
                    fetch,
                },
                consume,
            ),
        ).rejects.toBe(reason);
        expect(fetch).not.toHaveBeenCalled();
        expect(consume).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        "cleans unread control bodies and preserves consumer results/errors (%s)",
        async (fail) => {
            vi.useFakeTimers();
            const cancel = vi.fn();
            const error = new Error("parse failure");
            const pending = new HTTP({} as never).consumeControlResponse(
                "https://example.com",
                {
                    fetch: vi.fn(async () => new Response(new ReadableStream({ cancel }))),
                },
                async () => {
                    if (fail) throw error;
                    return { ok: true };
                },
            );
            if (fail) await expect(pending).rejects.toBe(error);
            else await expect(pending).resolves.toEqual({ ok: true });
            expect(cancel).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it("allows a full control response deadline to be disabled", async () => {
        vi.useFakeTimers();
        const consumed = Promise.withResolvers<string>();
        const pending = new HTTP({} as never).consumeControlResponse(
            "https://example.com",
            {
                timeout: false,
                fetch: vi.fn(async () => new Response()),
            },
            () => consumed.promise,
        );
        await vi.advanceTimersByTimeAsync(200_000);
        expect(vi.getTimerCount()).toBe(0);
        consumed.resolve("done");
        await expect(pending).resolves.toBe("done");
    });

    it("reports payload upload progress with transferred bytes and percent", async () => {
        const progress: Array<{ percent: number; transferredBytes: number; totalBytes: number }> =
            [];
        const customFetch = vi.fn(async (input: RequestInfo | URL) => {
            const request = input instanceof Request ? input : new Request(input);
            await request.body?.pipeTo(new WritableStream());
            return new Response("ok");
        });
        const http = new HTTP({} as never);

        await http.payloadRequest("https://example.com", {
            method: "PUT",
            body: "hello world",
            onUploadProgress: (value) => progress.push(value),
            fetch: customFetch,
        });

        expect(progress.length).toBeGreaterThan(0);
        expect(progress.at(-1)).toEqual({
            percent: 1,
            totalBytes: 11,
            transferredBytes: 11,
        });
    });

    it("pins Content-Length for fixed-size bodies", async () => {
        let seenRequest: Request | undefined;
        const customFetch = vi.fn((input: RequestInfo | URL) => {
            seenRequest = input instanceof Request ? input : new Request(input);
            return Promise.resolve(new Response("ok"));
        });
        const http = new HTTP({} as never);

        await http.payloadRequest("https://example.com", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ captcha: "9094 4194 6583 " }),
            fetch: customFetch,
        });

        expect(seenRequest?.headers.get("content-length")).toBe("23");
    });

    it("preserves an explicit Content-Length", async () => {
        let seenRequest: Request | undefined;
        const customFetch = vi.fn((input: RequestInfo | URL) => {
            seenRequest = input instanceof Request ? input : new Request(input);
            return Promise.resolve(new Response("ok"));
        });
        const http = new HTTP({} as never);

        await http.payloadRequest("https://example.com", {
            method: "POST",
            body: "short",
            headers: { "Content-Length": "5" },
            fetch: customFetch,
        });

        expect(seenRequest?.headers.get("content-length")).toBe("5");
    });
});
