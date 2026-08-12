import { Agent, Request as UndiciRequest, fetch as undiciFetch } from "undici";

import type { KioskDownloader } from "../index";

// Chromium's `net.fetch` crashes the main process when a response header
// contains non-Latin-1 characters (e.g. Korean filenames in Content-Disposition),
// so requests go through undici instead. Undici's Happy Eyeballs
// (internalConnectMultiple) can stall on broken IPv6 routes and surface as
// ETIMEDOUT; pinning the dispatcher to IPv4 avoids that without touching global
// DNS behavior. The IPv4 pin can be toggled via `network.forceIpv4`.
const ipv4Dispatcher = new Agent({ connect: { family: 4 } });

// The bundled undici used by globalThis Request is a different Request class than
// the undici package imported here, so a Request built via globalThis.Request
// is not recognized and would fail with "Failed to parse URL from [object Request]".
// Rebuild the request with the imported undici's Request class when needed.
function toUndiciInput(
    input: Parameters<typeof undiciFetch>[0],
): Parameters<typeof undiciFetch>[0] {
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
    input: Parameters<typeof undiciFetch>[0],
    init?: Parameters<typeof undiciFetch>[1],
    dispatcher?: Agent,
): Promise<Response> {
    return undiciFetch(toUndiciInput(input), { ...init, dispatcher }) as unknown as Response;
}

export async function ipv4Fetch(
    input: string | URL | Request,
    init?: RequestInit,
): Promise<Response> {
    return undiciRequest(
        input as Parameters<typeof undiciFetch>[0],
        init as Parameters<typeof undiciFetch>[1],
        ipv4Dispatcher,
    );
}

export async function plainUndiciFetch(
    input: string | URL | Request,
    _init?: RequestInit,
): Promise<Response> {
    return undiciRequest(input as Parameters<typeof undiciFetch>[0]);
}

const DEFAULT_TIMEOUT_MS = 100_000;
const RETRY_METHODS = ["get", "put", "head", "delete", "options", "trace"];
const RETRY_DELAY_BASE_MS = 300;

// Mirrors the network-error detection of the previous ky layer (is-network-error):
// only these raw fetch failures are retried. HTTP statuses are never retried
// because ky always ran with `throwHttpErrors: false`, and timeouts are not
// retried because ky's default `retryOnTimeout` is false.
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

// `statusCodes`, `afterStatusCodes`, `maxRetryAfter`, and `retryOnTimeout` are
// accepted for ky compatibility but intentionally unused: the previous ky layer
// always ran with `throwHttpErrors: false`, so HTTP statuses and timeouts were
// never retried. Only network errors are retried.
export type HttpRetryOptions = {
    limit?: number;
    methods?: string[];
    statusCodes?: number[];
    afterStatusCodes?: number[];
    maxRetryAfter?: number;
    backoffLimit?: number;
    delay?: (attemptCount: number) => number;
    retryOnTimeout?: boolean;
};

export type HttpRequestOptions = {
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
    signal?: AbortSignal;
    redirect?: RequestRedirect;
    timeout?: number | false;
    retry?: number | false | HttpRetryOptions;
    onUploadProgress?: (progress: UploadProgress) => void;
    fetch?: typeof fetch;
};

export class TimeoutError extends Error {
    public constructor(request: Request) {
        super(`Request timed out: ${request.method} ${request.url}`);
        this.name = "TimeoutError";
    }
}

type NormalizedRetryOptions = {
    limit: number;
    methods: string[];
    statusCodes: number[];
    afterStatusCodes: number[];
    maxRetryAfter: number;
    backoffLimit: number;
    delay: (attemptCount: number) => number;
    retryOnTimeout: boolean;
};

function normalizeRetryOptions(retry: HttpRequestOptions["retry"]): NormalizedRetryOptions {
    const defaults: NormalizedRetryOptions = {
        limit: 2,
        methods: RETRY_METHODS,
        statusCodes: [408, 413, 429, 500, 502, 503, 504],
        afterStatusCodes: [413, 429, 503],
        maxRetryAfter: Number.POSITIVE_INFINITY,
        backoffLimit: Number.POSITIVE_INFINITY,
        delay: (attemptCount) => RETRY_DELAY_BASE_MS * 2 ** (attemptCount - 1),
        retryOnTimeout: false,
    };
    if (retry === false) {
        return { ...defaults, limit: 0 };
    }
    if (typeof retry === "number") {
        return { ...defaults, limit: retry };
    }
    return { ...defaults, ...retry };
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

function retryDelayMs(retry: NormalizedRetryOptions, attempt: number) {
    return Math.min(retry.backoffLimit, retry.delay(attempt));
}

function delay(ms: number, signal?: AbortSignal) {
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

    public constructor(private readonly kd: KioskDownloader) {}

    public setForceIpv4(value: boolean) {
        this.forceIpv4 = value;
    }

    public pickFetch(options: HttpRequestOptions): typeof fetch {
        return options.fetch ?? (this.forceIpv4 ? ipv4Fetch : plainUndiciFetch);
    }

    public async getHeaders(_url: string) {
        return {
            "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36`,
        };
    }

    public async request(url: string, options: HttpRequestOptions = {}) {
        const retry = normalizeRetryOptions(options.retry);
        const headers = new Headers(options.headers);
        for (const [key, value] of Object.entries(await this.getHeaders(url))) {
            headers.set(key, value);
        }
        const fetchImpl = this.pickFetch(options);
        const timeoutMs =
            options.timeout === false ? undefined : (options.timeout ?? DEFAULT_TIMEOUT_MS);
        const method = (options.method ?? "GET").toUpperCase();
        const retriable = retry.limit > 0 && retry.methods.includes(method.toLowerCase());

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

        let request = new Request(url, {
            method,
            headers,
            body,
            signal: options.signal,
            redirect: options.redirect,
            // @ts-expect-error - `duplex` is not in the DOM RequestInit type but is required for stream bodies.
            duplex: body ? "half" : undefined,
        });
        for (let attempt = 1; ; attempt += 1) {
            // Cloning a streaming body calls ReadableStream#tee(), which buffers the
            // whole stream in memory, so only clone when a retry is actually possible.
            const retryRequest = retriable ? request.clone() : undefined;
            const progressRequest = options.onUploadProgress
                ? wrapRequestWithUploadProgress(request, options.body, options.onUploadProgress)
                : request;
            try {
                return await this.fetchWithTimeout(progressRequest, fetchImpl, timeoutMs);
            } catch (error) {
                if (!retriable || attempt > retry.limit || !isNetworkError(error)) {
                    throw error;
                }
                await delay(retryDelayMs(retry, attempt), options.signal);
                request = retryRequest ?? request;
            }
        }
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
