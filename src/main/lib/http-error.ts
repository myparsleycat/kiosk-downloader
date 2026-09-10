export const MAX_HTTP_ERROR_READ_BYTES = 8 * 1024;
export const MAX_HTTP_ERROR_PREVIEW_CHARS = 500;

const DIAGNOSTIC_HEADERS = [
    "content-type",
    "content-length",
    "server",
    "cf-ray",
    "cf-cache-status",
    "x-cache",
    "x-cache-status",
    "retry-after",
    "location",
    "x-amz-request-id",
    "x-amz-error-code",
    "x-amz-error-message",
] as const;

const MESSAGE_HEADERS = [
    "cf-ray",
    "cf-cache-status",
    "x-cache",
    "x-cache-status",
    "retry-after",
    "location",
    "x-amz-request-id",
    "x-amz-error-code",
    "x-amz-error-message",
    "server",
] as const;

export type HttpErrorBodyKind = "empty" | "text" | "json" | "html" | "cbor" | "binary";

export type HttpErrorSnapshot = {
    status: number;
    statusText: string;
    contentType: string | null;
    contentLength: string | null;
    headers: Record<string, string>;
    bodyKind: HttpErrorBodyKind;
    bodyPreview: string;
    bodyBytes: number;
};

export type CborResponse = {
    status: number;
    raw: Buffer;
    body: unknown;
    headers?: Headers;
};

export type HttpErrorBodyReadOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
};

const DEFAULT_BODY_READ_TIMEOUT_MS = 15_000;

export async function snapshotFailedResponse(
    response: Response,
    options: HttpErrorBodyReadOptions = {},
): Promise<HttpErrorSnapshot> {
    try {
        const bytes = await readLimitedBody(response, MAX_HTTP_ERROR_READ_BYTES, options);
        return snapshotFromBytes(
            response.status,
            response.statusText,
            response.headers,
            bytes,
            bytes.byteLength,
        );
    } catch {
        // A failed body read (dropped connection, abort, deadline) must not mask the HTTP status error.
        return snapshotFromBytes(
            response.status,
            response.statusText,
            response.headers,
            new Uint8Array(),
            0,
        );
    }
}

export function snapshotDecodedBody(
    status: number,
    decoded: unknown,
    raw?: Uint8Array,
    headers?: Headers,
): HttpErrorSnapshot {
    const contentType = headers?.get("content-type") ?? null;
    const contentLength = headers?.get("content-length") ?? null;
    const picked = headers ? pickHeaders(headers) : {};
    if (decoded != null && decoded !== "") {
        const kind = contentType?.toLowerCase().includes("cbor")
            ? "cbor"
            : typeof decoded === "string"
              ? classifyText(contentType, decoded)
              : "json";
        const preview = truncatePreview(
            typeof decoded === "string"
                ? previewFromText(decoded, kind)
                : stringifyDecoded(decoded),
        );
        return {
            status,
            statusText: "",
            contentType,
            contentLength,
            headers: picked,
            bodyKind: kind,
            bodyPreview: preview,
            bodyBytes: raw?.byteLength ?? Buffer.byteLength(preview),
        };
    }
    if (raw && raw.byteLength > 0) {
        const limited =
            raw.byteLength > MAX_HTTP_ERROR_READ_BYTES
                ? raw.subarray(0, MAX_HTTP_ERROR_READ_BYTES)
                : raw;
        return snapshotFromBytes(status, "", headers, limited, raw.byteLength);
    }
    return {
        status,
        statusText: "",
        contentType,
        contentLength,
        headers: picked,
        bodyKind: "empty",
        bodyPreview: "",
        bodyBytes: 0,
    };
}

export function formatHttpError(label: string, snapshot: HttpErrorSnapshot) {
    return `${label} HTTP ${snapshot.status}${formatHttpErrorDetail(snapshot)}`;
}

function formatHttpErrorDetail(snapshot: HttpErrorSnapshot) {
    const suffix = formatHeaderSuffix(snapshot);
    if (snapshot.bodyPreview) {
        return `: ${snapshot.bodyPreview}${suffix}`;
    }
    if (snapshot.bodyKind === "binary") {
        return ` [${snapshot.contentType ?? "binary"} ${snapshot.bodyBytes}B]${suffix}`;
    }
    return suffix;
}

export class CborHttpError extends Error {
    public constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
        this.name = "CborHttpError";
    }
}

export function cborHttpError(label: string, response: CborResponse) {
    return new CborHttpError(
        formatHttpError(
            label,
            snapshotDecodedBody(response.status, response.body, response.raw, response.headers),
        ),
        response.status,
    );
}

function snapshotFromBytes(
    status: number,
    statusText: string,
    headers: Headers | undefined,
    bytes: Uint8Array,
    bodyBytes: number,
): HttpErrorSnapshot {
    const contentType = headers?.get("content-type") ?? null;
    const contentLength = headers?.get("content-length") ?? null;
    const picked = headers ? pickHeaders(headers) : {};
    if (bytes.byteLength === 0) {
        return {
            status,
            statusText,
            contentType,
            contentLength,
            headers: picked,
            bodyKind: "empty",
            bodyPreview: "",
            bodyBytes,
        };
    }
    if (bytes.includes(0) || !isTextualContentType(contentType)) {
        return {
            status,
            statusText,
            contentType,
            contentLength,
            headers: picked,
            bodyKind: "binary",
            bodyPreview: "",
            bodyBytes,
        };
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const bodyKind = classifyText(contentType, text);
    return {
        status,
        statusText,
        contentType,
        contentLength,
        headers: picked,
        bodyKind,
        bodyPreview: truncatePreview(previewFromText(text, bodyKind)),
        bodyBytes,
    };
}

function pickHeaders(headers: Headers) {
    const picked: Record<string, string> = {};
    for (const name of DIAGNOSTIC_HEADERS) {
        const value = headers.get(name);
        if (!value) continue;
        picked[name] = name === "location" ? sanitizeLocation(value) : value;
    }
    return picked;
}

function formatHeaderSuffix(snapshot: HttpErrorSnapshot) {
    const parts = MESSAGE_HEADERS.flatMap((name) => {
        const value = snapshot.headers[name];
        return value ? [`${name}=${value}`] : [];
    });
    return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function sanitizeLocation(value: string) {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
    } catch {
        return value.split("?")[0] ?? value;
    }
}

async function readLimitedBody(
    response: Response,
    maxBytes: number,
    options: HttpErrorBodyReadOptions = {},
) {
    if (!response.body || response.body.locked) {
        return new Uint8Array();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (total < maxBytes) {
            const { done, value } = await readChunkWithDeadline(reader, options);
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            const remaining = maxBytes - total;
            if (value.byteLength <= remaining) {
                chunks.push(value);
                total += value.byteLength;
                continue;
            }
            chunks.push(value.subarray(0, remaining));
            total += remaining;
            break;
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        try {
            reader.releaseLock();
        } catch {
            // cancel() may already have released the lock.
        }
    }
    if (chunks.length === 0) return new Uint8Array();
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

// Mirrors the abort/deadline race of the download runner's readBodyChunk: a stalled
// response body must reject so the caller can fall back to the status-only snapshot.
function readChunkWithDeadline(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    options: HttpErrorBodyReadOptions,
) {
    return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
            settle(() => reject(options.signal?.reason));
        };
        const cleanup = () => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            options.signal?.removeEventListener("abort", onAbort);
        };
        const settle = (finish: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            finish();
        };

        timer = setTimeout(() => {
            settle(() => reject(new Error("Failed response body read timed out.")));
        }, options.timeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS);
        if (options.signal) {
            options.signal.addEventListener("abort", onAbort, { once: true });
            if (options.signal.aborted) {
                onAbort();
                return;
            }
        }
        reader.read().then(
            (result) => settle(() => resolve(result)),
            (error) => settle(() => reject(error)),
        );
    });
}

function isTextualContentType(contentType: string | null) {
    if (!contentType) return true;
    const type = contentType.toLowerCase();
    return (
        type.startsWith("text/") ||
        type.includes("json") ||
        type.includes("xml") ||
        type.includes("html") ||
        type.includes("javascript")
    );
}

function classifyText(contentType: string | null, text: string): HttpErrorBodyKind {
    const type = contentType?.toLowerCase() ?? "";
    if (type.includes("json")) return "json";
    if (type.includes("html") || type.includes("xml")) return "html";
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            JSON.parse(text);
            return "json";
        } catch {
            // Keep the original text classification below.
        }
    }
    if (trimmed.startsWith("<")) return "html";
    return "text";
}

function previewFromText(text: string, bodyKind: HttpErrorBodyKind) {
    if (bodyKind === "json") {
        try {
            return JSON.stringify(JSON.parse(text));
        } catch {
            // Fall through to collapsed text when the JSON is truncated or invalid.
        }
    }
    return collapseWhitespace(text);
}

function stringifyDecoded(value: unknown) {
    try {
        return JSON.stringify(value, jsonReplacer) ?? "";
    } catch {
        return collapseWhitespace(String(value));
    }
}

function jsonReplacer(_key: string, value: unknown) {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Map) return Object.fromEntries(value);
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return `<${value.byteLength} bytes>`;
    }
    return value;
}

function collapseWhitespace(text: string) {
    return text.replace(/\s+/g, " ").trim();
}

function truncatePreview(text: string) {
    if (text.length <= MAX_HTTP_ERROR_PREVIEW_CHARS) return text;
    return text.slice(0, MAX_HTTP_ERROR_PREVIEW_CHARS);
}
