import { createHash } from "node:crypto";

import { COLLECTION_EXPIRES_NEVER } from "@shared/download-errors";
import type { DirectRequestHeaders, DirNode } from "@shared/types";

import type { KioskDownloader } from "../..";
import type { DirectFileSourceMeta, LoadedDirectCollection } from "./types";

import { formatHttpError, snapshotFailedResponse } from "../../lib/http-error";
import { parseRetryAfterMs } from "../mega/mega-api";

export const DIRECT_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const FALLBACK_FILENAME = "download";

export class DirectRemoteChangedError extends Error {
    public constructor(message = "원격 파일이 변경되었습니다.") {
        super(message);
        this.name = "DirectRemoteChangedError";
    }
}

export type DirectProbe = {
    size: number;
    rangeSupported: boolean;
    finalUrl: string;
    etag?: string;
    lastModified?: string;
    contentDisposition: string | null;
};

export type DirectRequestOptions = {
    headers?: DirectRequestHeaders;
    /** URL whose origin the Cookie belongs to; defaults to the requested URL. */
    cookieOriginUrl?: string;
    range?: string;
    ifRange?: string;
    signal?: AbortSignal;
};

export class DirectHttpClient {
    public constructor(private readonly kd: KioskDownloader) {}

    public async loadCollection(
        payload: { url: string; headers?: DirectRequestHeaders; signal?: AbortSignal },
        asciiFilenames: boolean,
    ): Promise<LoadedDirectCollection> {
        const probe = await this.probe(payload.url, payload.headers, payload.signal);
        const name = this.kd.lib.fs.sanitizeDownloadPathSegment(
            resolveDirectFilename(probe.contentDisposition, probe.finalUrl, payload.url),
            { asciiFilenames },
        );
        const id = createHash("sha256").update(payload.url).digest("base64url").slice(0, 22);
        const tree: DirNode = {
            type: "dir",
            id,
            name: "",
            entries: [{ kind: "file", node: { type: "file", id, name, size: probe.size } }],
        };
        return {
            provider: "direct",
            collection: {
                shareId: new URL(payload.url).hostname,
                name,
                expires: COLLECTION_EXPIRES_NEVER,
                segmentSize: directSegmentSize(probe),
                passwordProtected: false,
                provider: "direct",
                tree,
            },
            rootId: id,
            passwordProtected: false,
            requestHeaders: payload.headers,
            fileMeta: toDirectSourceMeta(probe),
        };
    }

    public async probe(
        url: string,
        headers: DirectRequestHeaders | undefined,
        signal?: AbortSignal,
    ): Promise<DirectProbe> {
        const opened = await this.open(url, { headers, range: "bytes=0-0", signal });
        const response = opened.response;
        await response.body?.cancel().catch(() => undefined);

        const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
        if (encoding && encoding !== "identity") {
            throw new Error(
                `서버가 압축된 응답(${encoding})을 보내 파일 크기를 확인할 수 없습니다.`,
            );
        }

        const base = {
            finalUrl: opened.url,
            etag: response.headers.get("etag") ?? undefined,
            lastModified: response.headers.get("last-modified") ?? undefined,
            contentDisposition: response.headers.get("content-disposition"),
        };
        if (response.status === 206) {
            const total = parseContentRangeTotal(response.headers.get("content-range"));
            if (total === null) {
                throw new Error("서버가 파일 크기를 제공하지 않아 다운로드할 수 없습니다.");
            }
            return { ...base, size: total, rangeSupported: true };
        }
        if (response.status === 416) {
            if (parseContentRangeTotal(response.headers.get("content-range")) !== 0) {
                throw new Error("서버가 잘못된 Range 응답(416)을 보냈습니다.");
            }
            return { ...base, size: 0, rangeSupported: true };
        }

        const length = Number(response.headers.get("content-length") ?? Number.NaN);
        if (!Number.isSafeInteger(length) || length < 0) {
            throw new Error("서버가 파일 크기를 제공하지 않아 다운로드할 수 없습니다.");
        }
        return { ...base, size: length, rangeSupported: false };
    }

    /**
     * GET following redirects by hand: the Cookie header is only sent to the origin it was
     * entered for, and the final URL is reported for reuse by chunk requests.
     * Throws on any final status other than 200, 206 or 416.
     */
    public async open(url: string, options: DirectRequestOptions) {
        const cookieOrigin = new URL(options.cookieOriginUrl ?? url).origin;
        let current = url;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            const sameOrigin = new URL(current).origin === cookieOrigin;
            const response = await this.kd.http.payloadRequest(current, {
                method: "GET",
                headers: buildDirectHeaders(options, sameOrigin),
                redirect: "manual",
                signal: options.signal,
            });
            const location = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location) {
                await response.body?.cancel().catch(() => undefined);
                current = new URL(repairLatin1Mojibake(location), current).href;
                continue;
            }
            if (response.status !== 200 && response.status !== 206 && response.status !== 416) {
                const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
                throw new DirectHttpError(
                    response.status,
                    retryAfterMs,
                    formatHttpError(
                        "직접 다운로드",
                        await snapshotFailedResponse(response, { signal: options.signal }),
                    ),
                );
            }
            return { response, url: current };
        }
        throw new Error(`리다이렉트가 ${MAX_REDIRECTS}회를 넘었습니다.`);
    }
}

export class DirectHttpError extends Error {
    public constructor(
        public readonly status: number,
        public readonly retryAfterMs: number | undefined,
        message: string,
    ) {
        super(message);
        this.name = "DirectHttpError";
    }
}

export function directSegmentSize(probe: Pick<DirectProbe, "size" | "rangeSupported">) {
    return probe.rangeSupported ? DIRECT_CHUNK_SIZE : Math.max(1, probe.size);
}

export function toDirectSourceMeta(probe: DirectProbe): DirectFileSourceMeta {
    return {
        rangeSupported: probe.rangeSupported,
        finalUrl: probe.finalUrl,
        ...(probe.etag ? { etag: probe.etag } : {}),
        ...(probe.lastModified ? { lastModified: probe.lastModified } : {}),
    };
}

/** Strong validator for If-Range; weak ETags are not allowed there (RFC 9110 13.1.5). */
export function directIfRangeValidator(meta: DirectFileSourceMeta) {
    if (meta.etag && !meta.etag.startsWith("W/")) {
        return meta.etag;
    }
    return meta.lastModified;
}

export function hasDirectRemoteChanged(
    stored: DirectFileSourceMeta & { size: number },
    probe: DirectProbe,
) {
    return (
        stored.size !== probe.size ||
        stored.rangeSupported !== probe.rangeSupported ||
        hasDirectValidatorChanged(stored, probe)
    );
}

/** Compares ETags when both sides have one, otherwise Last-Modified. */
export function hasDirectValidatorChanged(
    stored: { etag?: string; lastModified?: string },
    current: { etag?: string | null; lastModified?: string | null },
) {
    if (stored.etag && current.etag) {
        return stored.etag !== current.etag;
    }
    return Boolean(
        stored.lastModified && current.lastModified && stored.lastModified !== current.lastModified,
    );
}

function buildDirectHeaders(options: DirectRequestOptions, sameOrigin: boolean) {
    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    if (options.headers?.referer) headers.Referer = options.headers.referer;
    if (options.headers?.userAgent) headers["User-Agent"] = options.headers.userAgent;
    if (options.headers?.cookie && sameOrigin) headers.Cookie = options.headers.cookie;
    if (options.range) headers.Range = options.range;
    if (options.ifRange) headers["If-Range"] = options.ifRange;
    return headers;
}

/** Total length from `Content-Range: bytes a-b/total` or `bytes *\/total`; null when unknown. */
export function parseContentRangeTotal(value: string | null) {
    const match = value ? /^bytes\s+(?:\d+-\d+|\*)\/(\d+)\s*$/i.exec(value.trim()) : null;
    if (!match) {
        return null;
    }
    const total = Number(match[1]);
    return Number.isSafeInteger(total) ? total : null;
}

export function resolveDirectFilename(
    contentDisposition: string | null,
    finalUrl: string,
    sourceUrl: string,
) {
    return (
        (contentDisposition && parseContentDispositionFilename(contentDisposition)) ||
        filenameFromUrl(finalUrl) ||
        filenameFromUrl(sourceUrl) ||
        FALLBACK_FILENAME
    );
}

function parseContentDispositionFilename(header: string) {
    // Some servers quote the ext-value even though RFC 8187 does not allow it.
    const extended = /filename\*\s*=\s*"?([^'";]*)'[^']*'([^;"]+)/i.exec(header);
    const extendedName = extended
        ? basename(decodeExtendedValue(extended[1], extended[2].trim()) ?? "")
        : "";
    if (extendedName) {
        return extendedName;
    }

    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
    const raw = plain ? (plain[1]?.replace(/\\(.)/g, "$1") ?? plain[2]?.trim()) : undefined;
    return raw ? basename(decodePercentEncoded(repairLatin1Mojibake(raw))) : null;
}

// Servers built on Java/.NET URL encoders send `filename="%ED%95%9C.zip"`; browsers
// decode it as UTF-8, so do the same when the whole value decodes cleanly.
function decodePercentEncoded(value: string) {
    if (!/%[\da-f]{2}/i.test(value)) {
        return value;
    }
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function decodeExtendedValue(charset: string, value: string) {
    const bytes: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === "%" && /^[\da-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
            bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
            index += 2;
        } else {
            bytes.push(value.charCodeAt(index) & 0xff);
        }
    }
    const encoding = charset.trim().toLowerCase() === "iso-8859-1" ? "latin1" : "utf-8";
    try {
        return new TextDecoder(encoding, { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
        return null;
    }
}

// Undici exposes header bytes as Latin-1 code units, so a raw UTF-8 filename (common
// on Korean servers) arrives as mojibake. Re-decode it when it is valid UTF-8.
function repairLatin1Mojibake(value: string) {
    const codes = Array.from({ length: value.length }, (_, index) => value.charCodeAt(index));
    if (!codes.some((code) => code >= 0x80) || codes.some((code) => code > 0xff)) {
        return value;
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "latin1"));
    } catch {
        return value;
    }
}

function filenameFromUrl(url: string) {
    const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    if (!segment) {
        return null;
    }
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function basename(value: string) {
    return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}
