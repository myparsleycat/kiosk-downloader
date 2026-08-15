import type { Dispatcher, RequestInit as UndiciRequestInit } from "undici";

import type { KioskDownloader } from "../index";

// Chromium's `net.fetch` crashes the main process when a response header
// contains non-Latin-1 characters (e.g. Korean filenames in Content-Disposition),
// so direct requests go through Undici. Proxied ordinary requests still use
// Chromium networking to preserve Electron session/PAC behavior. Undici's Happy
// Eyeballs (internalConnectMultiple) can stall on broken IPv6 routes and surface
// as ETIMEDOUT; pinning direct dispatchers to IPv4 avoids that without touching
// global DNS behavior. The IPv4 pin can be toggled via `network.forceIpv4`.
const dispatcherCache = new Map<string, Promise<Dispatcher>>();
let undiciModulePromise: Promise<typeof import("undici")> | undefined;

async function loadUndici() {
    if (!undiciModulePromise) {
        undiciModulePromise = (async () => {
            // Electron's bundled Undici owns the legacy dispatcher used by global fetch.
            // Initialize it before loading the npm package so the package import cannot
            // replace that dispatcher as a module-load side effect.
            if (typeof process.versions.electron === "string") {
                await globalThis.fetch("data:,");
            }
            return import("undici");
        })();
    }
    return undiciModulePromise;
}

function getDirectDispatcher(forceIpv4: boolean) {
    const key = forceIpv4 ? "direct:ipv4" : "direct:auto";
    const existing = dispatcherCache.get(key);
    if (existing) return existing;
    const created = loadUndici().then(
        ({ Agent }) => new Agent(forceIpv4 ? { connect: { family: 4 } } : undefined),
    );
    dispatcherCache.set(key, created);
    return created;
}

// The bundled undici used by globalThis Request is a different Request class than
// the undici package imported here, so a Request built via globalThis.Request
// is not recognized and would fail with "Failed to parse URL from [object Request]".
// Rebuild the request with the imported undici's Request class when needed.
function toUndiciInput(
    input: Parameters<typeof globalThis.fetch>[0],
    UndiciRequest: typeof import("undici").Request,
) {
    if (!(input instanceof Request)) {
        return input;
    }
    const hasBody = input.body !== null;
    return new UndiciRequest(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        duplex: hasBody ? "half" : undefined,
        signal: input.signal,
        redirect: input.redirect,
    });
}

async function undiciRequest(
    input: string | URL | Request,
    init?: RequestInit,
    dispatcher = getDirectDispatcher(false),
): Promise<Response> {
    const undici = await loadUndici();
    return undici.fetch(toUndiciInput(input, undici.Request), {
        ...(init as UndiciRequestInit),
        dispatcher: await dispatcher,
    }) as unknown as Response;
}

export async function ipv4Fetch(
    input: string | URL | Request,
    init?: RequestInit,
): Promise<Response> {
    return undiciRequest(input, init, getDirectDispatcher(true));
}

export async function plainUndiciFetch(
    input: string | URL | Request,
    init?: RequestInit,
): Promise<Response> {
    return undiciRequest(input, init);
}

const DEFAULT_TIMEOUT_MS = 100_000;

// Mirrors the network-error detection of the previous ky layer (is-network-error)
// so provider operations can decide whether their own operation is safe to retry.
const NETWORK_ERROR_MESSAGES = new Set([
    "network error",
    "NetworkError when attempting to fetch resource.",
    "The Internet connection appears to be offline.",
    "Network request failed",
    "fetch failed",
    "terminated",
    " A network error occurred.",
    "Network connection lost",
]);

export type UploadProgress = {
    percent: number;
    transferredBytes: number;
    totalBytes: number;
};

type BaseRequestOptions = {
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
    signal?: AbortSignal;
    redirect?: RequestRedirect;
    timeout?: number | false;
    fetch?: typeof fetch;
};

export type ControlRequestOptions = BaseRequestOptions;

export type PayloadRequestOptions = BaseRequestOptions & {
    onUploadProgress?: (progress: UploadProgress) => void;
};

export class TimeoutError extends Error {
    public constructor(request: Request) {
        super(`Request timed out: ${request.method} ${request.url}`);
        this.name = "TimeoutError";
    }
}

export function isNetworkError(error: unknown): error is Error {
    if (
        !(error instanceof Error) ||
        error.name !== "TypeError" ||
        typeof error.message !== "string"
    ) {
        return false;
    }
    return (
        NETWORK_ERROR_MESSAGES.has(error.message) ||
        error.message === "Failed to fetch" ||
        (error.message.startsWith("Failed to fetch (") && error.message.endsWith(")")) ||
        error.message.startsWith("error sending request for url")
    );
}

export function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal) {
            signal.throwIfAborted();
            signal.addEventListener("abort", abortHandler, { once: true });
        }
        function abortHandler() {
            clearTimeout(timeoutId);
            reject(signal?.reason);
        }
        const timeoutId = setTimeout(() => {
            signal?.removeEventListener("abort", abortHandler);
            resolve();
        }, ms);
    });
}

export class ProxyResolutionError extends Error {
    public constructor(url: string, proxyResult?: string, cause?: unknown) {
        super(
            proxyResult
                ? `No supported proxy directive was resolved for ${url}: ${proxyResult}`
                : `Failed to resolve a proxy for ${url}`,
            cause === undefined ? undefined : { cause },
        );
        this.name = "ProxyResolutionError";
    }
}

type ProxyDirective =
    | { type: "direct" }
    | { type: "http" | "https" | "socks4" | "socks5"; address: string };

function parseProxyDirectives(proxyResult: string): ProxyDirective[] {
    return proxyResult
        .split(";")
        .map((value) => value.trim())
        .flatMap((value): ProxyDirective[] => {
            if (value.toUpperCase() === "DIRECT") return [{ type: "direct" }];
            const match = /^(PROXY|HTTPS|SOCKS|SOCKS5)\s+(\S+)$/i.exec(value);
            if (!match) return [];
            const type = match[1].toUpperCase();
            return [
                {
                    type:
                        type === "PROXY"
                            ? "http"
                            : type === "HTTPS"
                              ? "https"
                              : type === "SOCKS"
                                ? "socks4"
                                : "socks5",
                    address: match[2],
                },
            ];
        });
}

function isDirectProxyResult(proxyResult: string) {
    const directives = proxyResult
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean);
    return directives.length > 0 && directives.every((value) => value.toUpperCase() === "DIRECT");
}

function getProxyDispatcher(
    directive: Exclude<ProxyDirective, { type: "direct" }>,
    forceIpv4: boolean,
) {
    const key = `proxy:${forceIpv4 ? "ipv4" : "auto"}:${directive.type}:${directive.address}`;
    const existing = dispatcherCache.get(key);
    if (existing) return existing;
    const created =
        directive.type === "socks4" || directive.type === "socks5"
            ? loadUndici().then(async () => {
                  const { socksDispatcher } = await import("fetch-socks");
                  const url = new URL(`http://${directive.address}`);
                  return socksDispatcher({
                      type: directive.type === "socks4" ? 4 : 5,
                      host: url.hostname,
                      port: Number(url.port || 1080),
                  });
              })
            : loadUndici().then(
                  ({ ProxyAgent }) => new ProxyAgent(`${directive.type}://${directive.address}`),
              );
    dispatcherCache.set(key, created);
    return created;
}

function getBodySize(body: BodyInit | null | undefined): number {
    if (!body) {
        return 0;
    }
    if (body instanceof Blob) {
        return body.size;
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        return body.byteLength;
    }
    if (typeof body === "string") {
        return new TextEncoder().encode(body).byteLength;
    }
    if (body instanceof URLSearchParams) {
        return new TextEncoder().encode(body.toString()).byteLength;
    }
    return 0;
}

function wrapRequestWithUploadProgress(
    request: Request,
    originalBody: BodyInit | null | undefined,
    onUploadProgress: (progress: UploadProgress) => void,
): Request {
    if (!request.body) {
        return request;
    }
    const totalBytes =
        getBodySize(originalBody ?? request.body) ||
        Number(request.headers.get("content-length")) ||
        0;
    let previousChunk: Uint8Array | undefined;
    let transferredBytes = 0;
    const stream = request.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(currentChunk, controller) {
                controller.enqueue(currentChunk);
                if (previousChunk) {
                    transferredBytes += previousChunk.byteLength;
                    let percent = totalBytes === 0 ? 0 : transferredBytes / totalBytes;
                    // Avoid reporting 100% before the stream is actually finished.
                    if (percent >= 1) {
                        percent = 1 - Number.EPSILON;
                    }
                    onUploadProgress({
                        percent,
                        totalBytes: Math.max(totalBytes, transferredBytes),
                        transferredBytes,
                    });
                }
                previousChunk = currentChunk;
            },
            flush() {
                if (previousChunk) {
                    transferredBytes += previousChunk.byteLength;
                    onUploadProgress({
                        percent: 1,
                        totalBytes: Math.max(totalBytes, transferredBytes),
                        transferredBytes,
                    });
                }
            },
        }),
    );
    return new Request(request, {
        body: stream,
        // @ts-expect-error - `duplex` is not in the DOM RequestInit type but is required for stream bodies.
        duplex: "half",
    });
}

export class HTTP {
    private forceIpv4 = true;

    public constructor(_kd: KioskDownloader) {}

    public setForceIpv4(value: boolean) {
        this.forceIpv4 = value;
    }

    private async controlFetch(url: string): Promise<typeof fetch> {
        const { net, session } = await import("electron");
        try {
            if (!isDirectProxyResult(await session.defaultSession.resolveProxy(url))) {
                return (input, init) =>
                    net.fetch(input instanceof URL ? input.href : input, init) as Promise<Response>;
            }
        } catch {
            return (input, init) =>
                net.fetch(input instanceof URL ? input.href : input, init) as Promise<Response>;
        }
        return this.forceIpv4 ? ipv4Fetch : plainUndiciFetch;
    }

    private async payloadFetch(url: string): Promise<typeof fetch> {
        const { session } = await import("electron");
        let proxyResult: string;
        try {
            proxyResult = await session.defaultSession.resolveProxy(url);
        } catch (error) {
            throw new ProxyResolutionError(url, undefined, error);
        }

        const directives = parseProxyDirectives(proxyResult);
        const directive = directives[0];
        if (!directive) throw new ProxyResolutionError(url, proxyResult);
        if (directive.type === "direct") {
            return this.forceIpv4 ? ipv4Fetch : plainUndiciFetch;
        }
        const dispatcher = getProxyDispatcher(directive, this.forceIpv4);
        return (input, init) => undiciRequest(input, init, dispatcher);
    }

    public async destroy() {
        const dispatchers = [...dispatcherCache.values()];
        dispatcherCache.clear();
        await Promise.all(dispatchers.map(async (dispatcher) => (await dispatcher).close()));
    }

    public async getHeaders(_url: string) {
        return {
            "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36`,
        };
    }

    public async controlRequest(url: string, options: ControlRequestOptions = {}) {
        return this.executeRequest(url, options, options.fetch ?? (await this.controlFetch(url)));
    }

    public async payloadRequest(url: string, options: PayloadRequestOptions = {}) {
        return this.executeRequest(url, options, options.fetch ?? (await this.payloadFetch(url)));
    }

    private async executeRequest(
        url: string,
        options: PayloadRequestOptions,
        fetchImpl: typeof fetch,
    ) {
        const headers = new Headers(options.headers);
        for (const [key, value] of Object.entries(await this.getHeaders(url))) {
            headers.set(key, value);
        }
        const timeoutMs =
            options.timeout === false ? undefined : (options.timeout ?? DEFAULT_TIMEOUT_MS);
        const method = (options.method ?? "GET").toUpperCase();

        // A URLSearchParams body passed through `new Request` becomes a stream,
        // losing its length so undici sends it chunked. Workupload rejects POST
        // bodies without a Content-Length, so serialize URLSearchParams and pin
        // Content-Length for any fixed-size body before building the request.
        const body =
            options.body instanceof URLSearchParams ? options.body.toString() : options.body;
        const bodySize = getBodySize(body);
        if (bodySize > 0 && !headers.has("content-length")) {
            headers.set("Content-Length", String(bodySize));
        }

        const request = new Request(url, {
            method,
            headers,
            body,
            signal: options.signal,
            redirect: options.redirect,
            // @ts-expect-error - `duplex` is not in the DOM RequestInit type but is required for stream bodies.
            duplex: body ? "half" : undefined,
        });
        return this.fetchWithTimeout(
            options.onUploadProgress
                ? wrapRequestWithUploadProgress(request, options.body, options.onUploadProgress)
                : request,
            fetchImpl,
            timeoutMs,
        );
    }

    private fetchWithTimeout(
        request: Request,
        fetchImpl: typeof fetch,
        timeoutMs: number | undefined,
    ): Promise<Response> {
        if (timeoutMs === undefined) {
            return fetchImpl(request);
        }
        const controller = new AbortController();
        const signal = request.signal
            ? AbortSignal.any([request.signal, controller.signal])
            : controller.signal;
        const timedRequest = new Request(request, {
            signal,
            // @ts-expect-error - `duplex` is not in the DOM RequestInit type but is required for stream bodies.
            duplex: request.body ? "half" : undefined,
        });
        return new Promise<Response>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                controller.abort();
                reject(new TimeoutError(request));
            }, timeoutMs);
            fetchImpl(timedRequest)
                .then(resolve)
                .catch(reject)
                .finally(() => clearTimeout(timeoutId));
        });
    }
}
