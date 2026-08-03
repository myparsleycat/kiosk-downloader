import crypto from "node:crypto";

import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import type {
    DirNode,
    LoadCollectionPayload,
    ProbeCollectionPayload,
    ProbeCollectionResult,
} from "@shared/types";

import type { KioskDownloader } from "../..";

import { COLLECTION_EXPIRES_NEVER } from "./transfer-it-crypto";

const ORIGIN = "https://workupload.com";
const WORKUPLOAD_HOST = "workupload.com";
const AJAX_ACCEPT = "application/json, text/javascript, */*; q=0.01";
const PUZZLE_SEARCH_BATCH_SIZE = 1_000;

export class WorkuploadHttpError extends Error {
    public constructor(
        stage: string,
        public readonly status: number,
    ) {
        super(`Workupload ${stage} failed with HTTP ${status}.`);
        this.name = "WorkuploadHttpError";
    }
}

export type WorkuploadResource = {
    kind: "file" | "archive";
    key: string;
    sourceUrl: string;
};

export type WorkuploadFileMetadata = {
    fileKey: string;
    filename: string;
    size: number;
    sha256: string;
};

export type WorkuploadSource =
    | {
          kind: "file";
          key: string;
          name: string;
          size: number;
          files: [WorkuploadFileMetadata];
      }
    | {
          kind: "archive";
          key: string;
          name: string;
          size: number;
          files: WorkuploadFileMetadata[];
      };

export type WorkuploadLoadedCollection = {
    provider: "workupload";
    resource: "file" | "archive";
    collection: {
        shareId: string;
        name: string;
        expires: number;
        segmentSize: number;
        passwordProtected: boolean;
        provider: "workupload";
        tree: DirNode;
    };
    rootId: string;
    passwordProtected: boolean;
    fileMetaByRemoteId: Map<string, { originalName: string; sha256: string }>;
    files: WorkuploadFileMetadata[];
    sourceUrl: string;
};

type RequestDownloadOptions = {
    start?: number;
    end?: number;
    signal?: AbortSignal;
};

type CreateSessionOptions = {
    requestedFileKey?: string;
    password?: string;
    signal?: AbortSignal;
};

type ArchivePage = {
    archiveKey: string;
    name: string;
    size: number;
    files: Array<{ fileKey: string; filename: string }>;
};

type ArchiveManifestEntry = {
    fileKey: string;
    size: number;
};

type StoredCookie = {
    name: string;
    value: string;
    domain: string;
    hostOnly: boolean;
    path: string;
    secure: boolean;
    expiresAt?: number;
    createdAt: number;
};

class CookieJar {
    private readonly cookies = new Map<string, StoredCookie>();
    private nextCreatedAt = 0;

    public store(response: Response, requestUrl: string) {
        const url = new URL(requestUrl);
        for (const header of response.headers.getSetCookie()) {
            const [pair, ...rawAttributes] = header.split(";");
            const separator = pair.indexOf("=");
            if (separator <= 0) {
                continue;
            }

            const name = pair.slice(0, separator).trim();
            if (!name) {
                continue;
            }
            const value = pair.slice(separator + 1).trim();
            let domain = url.hostname;
            let hostOnly = true;
            let cookiePath = defaultCookiePath(url.pathname);
            let secure = false;
            let expiresAt: number | undefined;
            let maxAge: number | undefined;

            for (const rawAttribute of rawAttributes) {
                const attribute = rawAttribute.trim();
                const attributeSeparator = attribute.indexOf("=");
                const attributeName = (
                    attributeSeparator < 0 ? attribute : attribute.slice(0, attributeSeparator)
                ).toLowerCase();
                const attributeValue =
                    attributeSeparator < 0 ? "" : attribute.slice(attributeSeparator + 1).trim();

                if (attributeName === "domain") {
                    const candidate = attributeValue.toLowerCase().replace(/^\.+/, "");
                    if (
                        !candidate ||
                        (candidate !== WORKUPLOAD_HOST &&
                            !candidate.endsWith(`.${WORKUPLOAD_HOST}`)) ||
                        !domainMatches(url.hostname, candidate)
                    ) {
                        domain = "";
                        break;
                    }
                    domain = candidate;
                    hostOnly = false;
                } else if (attributeName === "path" && attributeValue.startsWith("/")) {
                    cookiePath = attributeValue;
                } else if (attributeName === "secure") {
                    secure = true;
                } else if (attributeName === "max-age") {
                    const seconds = Number(attributeValue);
                    if (Number.isFinite(seconds)) {
                        maxAge = seconds;
                    }
                } else if (attributeName === "expires") {
                    const parsed = Date.parse(attributeValue);
                    if (!Number.isNaN(parsed)) {
                        expiresAt = parsed;
                    }
                }
            }

            if (!domain) {
                continue;
            }
            if (maxAge !== undefined) {
                expiresAt = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
            }

            const key = cookieKey(name, domain, cookiePath);
            if (expiresAt !== undefined && expiresAt <= Date.now()) {
                this.cookies.delete(key);
                continue;
            }
            const existing = this.cookies.get(key);
            this.cookies.set(key, {
                name,
                value,
                domain,
                hostOnly,
                path: cookiePath,
                secure,
                expiresAt,
                createdAt: existing?.createdAt ?? this.nextCreatedAt++,
            });
        }
    }

    public header(requestUrl: string) {
        const url = new URL(requestUrl);
        const now = Date.now();
        const matches: StoredCookie[] = [];
        for (const [key, cookie] of this.cookies) {
            if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
                this.cookies.delete(key);
                continue;
            }
            if (
                (cookie.secure && url.protocol !== "https:") ||
                (cookie.hostOnly
                    ? url.hostname !== cookie.domain
                    : !domainMatches(url.hostname, cookie.domain)) ||
                !pathMatches(url.pathname, cookie.path)
            ) {
                continue;
            }
            matches.push(cookie);
        }
        return matches
            .sort(
                (left, right) =>
                    right.path.length - left.path.length || left.createdAt - right.createdAt,
            )
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; ");
    }
}

function cookieKey(name: string, domain: string, path: string) {
    return `${name}\0${domain}\0${path}`;
}

function domainMatches(hostname: string, domain: string) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
}

function defaultCookiePath(pathname: string) {
    if (!pathname.startsWith("/") || pathname === "/") {
        return "/";
    }
    const lastSlash = pathname.lastIndexOf("/");
    return lastSlash === 0 ? "/" : pathname.slice(0, lastSlash);
}

function pathMatches(pathname: string, cookiePath: string) {
    return (
        pathname === cookiePath ||
        (pathname.startsWith(cookiePath) &&
            (cookiePath.endsWith("/") || pathname[cookiePath.length] === "/"))
    );
}

export function parseWorkuploadInput(input: string): WorkuploadResource {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new Error(`Invalid Workupload URL: ${input}`);
    }
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        ![WORKUPLOAD_HOST, `www.${WORKUPLOAD_HOST}`].includes(url.hostname)
    ) {
        throw new Error(`Unsupported Workupload origin: ${url.origin}`);
    }

    const file = url.pathname.match(/^\/(?:file|start)\/([A-Za-z0-9]+)\/?$/);
    if (file) {
        return { kind: "file", key: file[1], sourceUrl: `${ORIGIN}/file/${file[1]}` };
    }
    const archive = url.pathname.match(/^\/archive\/([A-Za-z0-9]+)\/?$/);
    if (archive) {
        return {
            kind: "archive",
            key: archive[1],
            sourceUrl: `${ORIGIN}/archive/${archive[1]}`,
        };
    }
    throw new Error(`Unsupported Workupload URL path: ${url.pathname}`);
}

function decodeHtml(value: string) {
    return value
        .replace(/<[^>]*>/g, "")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
            String.fromCodePoint(Number.parseInt(code, 16)),
        )
        .replace(/&quot;/g, '"')
        .replace(/&#039;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .trim();
}

function safeSize(value: string, context: string) {
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Invalid Workupload byte size for ${context}.`);
    }
    return size;
}

export function parseWorkuploadFileMetadata(html: string, fileKey: string) {
    const filename = html.match(/Filename:&nbsp;<\/td><td[^>]*>([\s\S]*?)<\/td>/i)?.[1];
    const size = html.match(/Filesize:&nbsp;<\/td><td>(\d+) \(Byte\)/i)?.[1];
    const sha256 = html.match(/Checksum:&nbsp;<\/td><td[^>]*>([a-f\d]{64}) \(SHA256\)/i)?.[1];
    if (!filename || !size || !sha256) {
        throw new Error(`Could not parse metadata for Workupload file ${fileKey}.`);
    }
    return {
        fileKey,
        filename: decodeHtml(filename),
        size: safeSize(size, `file ${fileKey}`),
        sha256: sha256.toLowerCase(),
    } satisfies WorkuploadFileMetadata;
}

export function parseWorkuploadArchivePage(html: string, archiveKey: string): ArchivePage {
    const name = html.match(/Archive name:&nbsp;<\/td><td>([\s\S]*?)<\/td>/i)?.[1];
    const size = html.match(/Archive size:&nbsp;<\/td><td>(\d+) \(byte\)/i)?.[1];
    const files: ArchivePage["files"] = [];
    const rows =
        /<tr>[\s\S]*?<td[^>]*><b>([\s\S]*?)<\/b><\/td>[\s\S]*?<a href="\/file\/([A-Za-z0-9]+)"[^>]*>[\s\S]*?Download[\s\S]*?<\/a>[\s\S]*?<\/tr>/gi;
    for (const match of html.matchAll(rows)) {
        files.push({ fileKey: match[2], filename: decodeHtml(match[1]) });
    }
    if (!name || !size || files.length === 0) {
        throw new Error(`Could not parse metadata for Workupload archive ${archiveKey}.`);
    }
    if (new Set(files.map((file) => file.fileKey)).size !== files.length) {
        throw new Error(`Workupload archive ${archiveKey} contains duplicate file keys.`);
    }
    return {
        archiveKey,
        name: decodeHtml(name),
        size: safeSize(size, `archive ${archiveKey}`),
        files,
    };
}

export function parseWorkuploadArchiveManifest(
    html: string,
    archiveKey: string,
): ArchiveManifestEntry[] {
    const encoded = html.match(/\bvar kas\s*=\s*(\[[^;]+\]);/i)?.[1];
    if (!encoded) {
        throw new Error(`Could not parse file manifest for Workupload archive ${archiveKey}.`);
    }
    let values: unknown;
    try {
        values = JSON.parse(encoded);
    } catch {
        throw new Error(`Workupload archive ${archiveKey} has an invalid file manifest.`);
    }
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error(`Workupload archive ${archiveKey} has an empty file manifest.`);
    }
    const entries = values.map((value): ArchiveManifestEntry => {
        const match = typeof value === "string" ? value.match(/^([A-Za-z0-9]+)_(\d+)$/) : null;
        if (!match) {
            throw new Error(`Workupload archive ${archiveKey} has an invalid manifest entry.`);
        }
        return { fileKey: match[1], size: safeSize(match[2], `archive child ${match[1]}`) };
    });
    if (new Set(entries.map((entry) => entry.fileKey)).size !== entries.length) {
        throw new Error(`Workupload archive ${archiveKey} contains duplicate manifest keys.`);
    }
    return entries;
}

export class WorkuploadSession {
    public constructor(
        private readonly kd: KioskDownloader,
        private readonly jar: CookieJar,
        public readonly source: WorkuploadSource,
        public readonly passwordProtected: boolean,
        private readonly referer: string,
        private readonly allowedFileKeys = new Set(source.files.map((file) => file.fileKey)),
    ) {}

    public async resolveDownloadUrl(fileKey: string) {
        this.requireChild(fileKey);
        const response = await request(
            this.kd,
            this.jar,
            `${ORIGIN}/api/file/getDownloadServer/${fileKey}`,
            {
                headers: {
                    Accept: AJAX_ACCEPT,
                    Referer: this.referer,
                    "X-Requested-With": "XMLHttpRequest",
                },
            },
        );
        const envelope = await readJson(response, `resolve-cdn ${fileKey}`);
        const record = asRecord(envelope);
        const data = asRecord(record?.data);
        if (record?.success !== true || typeof data?.url !== "string") {
            throw new Error(`Workupload resolve-cdn returned an invalid response for ${fileKey}.`);
        }
        const url = new URL(data.url);
        if (
            url.protocol !== "https:" ||
            !/^f\d+\.workupload\.com$/i.test(url.hostname) ||
            url.pathname !== `/download/${fileKey}` ||
            url.search ||
            url.hash ||
            url.username ||
            url.password ||
            url.port
        ) {
            throw new Error(`Unexpected Workupload CDN URL for ${fileKey}.`);
        }
        return url.href;
    }

    public async requestDownload(fileKey: string, options: RequestDownloadOptions = {}) {
        const url = await this.resolveDownloadUrl(fileKey);
        const headers: Record<string, string> = {};
        if (options.start !== undefined) {
            if (!Number.isSafeInteger(options.start) || options.start < 0) {
                throw new Error("Invalid Workupload download range start.");
            }
            if (
                options.end !== undefined &&
                (!Number.isSafeInteger(options.end) || options.end < options.start)
            ) {
                throw new Error("Invalid Workupload download range end.");
            }
            headers.Range = `bytes=${options.start}-${options.end ?? ""}`;
        } else if (options.end !== undefined) {
            throw new Error("Workupload download range end requires a start.");
        }
        return {
            url,
            response: await request(this.kd, this.jar, url, {
                headers,
                signal: options.signal,
                timeout: false,
            }),
        };
    }

    private requireChild(fileKey: string) {
        if (!this.allowedFileKeys.has(fileKey)) {
            throw new Error(`Workupload file ${fileKey} is not part of this session.`);
        }
    }
}

export class WorkuploadApiClient {
    public constructor(private readonly kd: KioskDownloader) {}

    public async probeCollection(payload: ProbeCollectionPayload): Promise<ProbeCollectionResult> {
        const resource = parseWorkuploadInput(payload.url);
        const jar = new CookieJar();
        return {
            passwordRequired: hasPasswordForm(
                await loadPage(
                    this.kd,
                    jar,
                    resource.sourceUrl,
                    `probe GET /${resource.kind}/${resource.key}`,
                ),
                resource,
            ),
        };
    }

    public async loadCollection(
        payload: LoadCollectionPayload,
    ): Promise<WorkuploadLoadedCollection> {
        const session = await this.createSession(payload.url, { password: payload.password });
        const resource = parseWorkuploadInput(payload.url);
        const tree: DirNode = {
            type: "dir",
            id: resource.key,
            name: "",
            entries: session.source.files.map((file) => ({
                kind: "file" as const,
                node: {
                    type: "file" as const,
                    id: file.fileKey,
                    name: file.filename,
                    size: file.size,
                },
            })),
        };
        return {
            provider: "workupload",
            resource: resource.kind,
            collection: {
                shareId: resource.key,
                name: session.source.name,
                expires: COLLECTION_EXPIRES_NEVER,
                segmentSize: Math.max(1, ...session.source.files.map((file) => file.size)),
                passwordProtected: session.passwordProtected,
                provider: "workupload",
                tree,
            },
            rootId: resource.key,
            passwordProtected: session.passwordProtected,
            fileMetaByRemoteId: new Map(
                session.source.files.map((file) => [
                    file.fileKey,
                    { originalName: file.filename, sha256: file.sha256 },
                ]),
            ),
            files: session.source.files,
            sourceUrl: resource.sourceUrl,
        };
    }

    public async createSession(sourceUrl: string, options: CreateSessionOptions = {}) {
        const resource = parseWorkuploadInput(sourceUrl);
        if (
            resource.kind === "file" &&
            options.requestedFileKey &&
            options.requestedFileKey !== resource.key
        ) {
            throw new Error(
                `Workupload file ${options.requestedFileKey} does not match ${resource.key}.`,
            );
        }
        const jar = new CookieJar();
        return resource.kind === "file"
            ? await this.createFileSession(resource, jar, options.password, options.signal)
            : await this.createArchiveSession(
                  resource,
                  jar,
                  options.requestedFileKey,
                  options.password,
                  options.signal,
              );
    }

    public async refreshSession(sourceUrl: string, options: CreateSessionOptions = {}) {
        return await this.createSession(sourceUrl, options);
    }

    private async createFileSession(
        resource: WorkuploadResource,
        jar: CookieJar,
        password?: string,
        signal?: AbortSignal,
    ) {
        const fileUrl = resource.sourceUrl;
        const loaded = await loadFileMetadata(this.kd, jar, resource.key, password, signal);
        const startUrl = `${ORIGIN}/start/${resource.key}`;
        await activateFileSession(this.kd, jar, fileUrl, startUrl, signal);
        const source: WorkuploadSource = {
            kind: "file",
            key: resource.key,
            name: loaded.metadata.filename,
            size: loaded.metadata.size,
            files: [loaded.metadata],
        };
        return new WorkuploadSession(this.kd, jar, source, loaded.passwordProtected, startUrl);
    }

    private async createArchiveSession(
        resource: WorkuploadResource,
        jar: CookieJar,
        requestedFileKey?: string,
        password?: string,
        signal?: AbortSignal,
    ) {
        const archiveUrl = resource.sourceUrl;
        const loadedArchive = await loadProtectedPage(this.kd, jar, resource, password, signal);
        const archive = parseWorkuploadArchivePage(loadedArchive.html, resource.key);
        const startUrl = `${archiveUrl}/start`;
        const manifest = parseWorkuploadArchiveManifest(
            await loadPage(
                this.kd,
                jar,
                startUrl,
                `GET /archive/${resource.key}/start`,
                archiveUrl,
                signal,
            ),
            resource.key,
        );
        if (
            manifest.length !== archive.files.length ||
            manifest.some((entry, index) => entry.fileKey !== archive.files[index]?.fileKey)
        ) {
            throw new Error(`Workupload archive ${resource.key} page and manifest do not match.`);
        }
        if (manifest.reduce((sum, entry) => sum + entry.size, 0) !== archive.size) {
            throw new Error(`Workupload archive ${resource.key} total size does not match.`);
        }
        const requestedEntries = requestedFileKey
            ? manifest
                  .map((entry, index) => ({ entry, index }))
                  .filter(({ entry }) => entry.fileKey === requestedFileKey)
            : manifest.map((entry, index) => ({ entry, index }));
        if (requestedEntries.length === 0) {
            throw new Error(
                `Workupload file ${requestedFileKey} is not part of archive ${resource.key}.`,
            );
        }
        const files: WorkuploadFileMetadata[] = [];
        let childPasswordProtected = false;
        for (const { entry, index } of requestedEntries) {
            const loaded = await loadFileMetadata(this.kd, jar, entry.fileKey, password, signal);
            const metadata = loaded.metadata;
            childPasswordProtected ||= loaded.passwordProtected;
            if (
                metadata.size !== entry.size ||
                metadata.filename !== archive.files[index]?.filename
            ) {
                throw new Error(
                    `Workupload archive ${resource.key} child metadata mismatch: ${entry.fileKey}.`,
                );
            }
            files.push(metadata);
        }
        const source: WorkuploadSource = {
            kind: "archive",
            key: resource.key,
            name: archive.name,
            size: archive.size,
            files,
        };
        return new WorkuploadSession(
            this.kd,
            jar,
            source,
            loadedArchive.passwordProtected || childPasswordProtected,
            startUrl,
            new Set(manifest.map((entry) => entry.fileKey)),
        );
    }
}

function asRecord(value: unknown) {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

async function request(
    kd: KioskDownloader,
    jar: CookieJar,
    url: string,
    options: Record<string, unknown> = {},
) {
    const headers = new Headers(options.headers as HeadersInit | undefined);
    headers.set("Connection", "close");
    if (!headers.has("Accept")) headers.set("Accept", "*/*");
    const cookieHeader = jar.header(url);
    if (cookieHeader) headers.set("Cookie", cookieHeader);
    const response = await kd.http.request(url, {
        ...options,
        headers,
        redirect: "manual",
        retry: 0,
    });
    jar.store(response, url);
    return response;
}

async function readText(response: Response, stage: string) {
    const body = await response.text();
    if (response.status >= 400) {
        throw new WorkuploadHttpError(stage, response.status);
    }
    return body;
}

async function readJson(response: Response, stage: string) {
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new WorkuploadHttpError(stage, response.status);
    }
    const body = await readText(response, stage);
    try {
        return JSON.parse(body) as unknown;
    } catch {
        throw new Error(`Workupload ${stage} returned invalid JSON.`);
    }
}

async function loadPage(
    kd: KioskDownloader,
    jar: CookieJar,
    url: string,
    stage: string,
    referer = url,
    signal?: AbortSignal,
) {
    const first = await readText(
        await request(kd, jar, url, { headers: { Referer: referer }, signal }),
        stage,
    );
    if (!first.includes("/puzzle")) return first;
    await passSecurityCheck(kd, jar, url, signal);
    return await readText(
        await request(kd, jar, url, { headers: { Referer: referer }, signal }),
        `${stage} retry`,
    );
}

async function loadFileMetadata(
    kd: KioskDownloader,
    jar: CookieJar,
    fileKey: string,
    password?: string,
    signal?: AbortSignal,
) {
    const loaded = await loadProtectedPage(
        kd,
        jar,
        { kind: "file", key: fileKey, sourceUrl: `${ORIGIN}/file/${fileKey}` },
        password,
        signal,
    );
    return {
        metadata: parseWorkuploadFileMetadata(loaded.html, fileKey),
        passwordProtected: loaded.passwordProtected,
    };
}

function passwordFormName(resource: WorkuploadResource) {
    return `passwordprotected_${resource.kind}`;
}

function hasPasswordForm(html: string, resource: WorkuploadResource) {
    const name = passwordFormName(resource);
    if (!new RegExp(`<form[^>]+name=["']${name}["']`, "i").test(html)) {
        return false;
    }
    if (
        !new RegExp(`name=["']${name}\\[password\\]["']`, "i").test(html) ||
        !new RegExp(`name=["']${name}\\[key\\]["'][^>]+value=["']${resource.key}["']`, "i").test(
            html,
        )
    ) {
        throw new Error(`Workupload ${resource.kind} password form is malformed.`);
    }
    return true;
}

async function loadProtectedPage(
    kd: KioskDownloader,
    jar: CookieJar,
    resource: WorkuploadResource,
    password?: string,
    signal?: AbortSignal,
) {
    const stage = `metadata GET /${resource.kind}/${resource.key}`;
    const first = await loadPage(kd, jar, resource.sourceUrl, stage, resource.sourceUrl, signal);
    if (!hasPasswordForm(first, resource)) {
        return { html: first, passwordProtected: false };
    }
    if (!password) {
        throw new Error(COLLECTION_PASSWORD_REQUIRED_ERROR);
    }

    const name = passwordFormName(resource);
    const response = await request(kd, jar, resource.sourceUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: resource.sourceUrl,
        },
        body: new URLSearchParams({
            [`${name}[password]`]: password,
            [`${name}[submit]`]: "",
            [`${name}[key]`]: resource.key,
        }),
        signal,
    });
    const html =
        response.status >= 300 && response.status < 400
            ? await loadPasswordRedirect(kd, jar, response, resource, signal)
            : await readText(response, `password POST /${resource.kind}/${resource.key}`);
    if (
        html.includes("The password you entered is incorrect.") ||
        hasPasswordForm(html, resource)
    ) {
        throw new Error(COLLECTION_INVALID_PASSWORD_ERROR);
    }
    return { html, passwordProtected: true };
}

async function loadPasswordRedirect(
    kd: KioskDownloader,
    jar: CookieJar,
    response: Response,
    resource: WorkuploadResource,
    signal?: AbortSignal,
) {
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
        throw new Error(`Workupload ${resource.kind} password redirect is missing a location.`);
    }
    const redirect = new URL(location, resource.sourceUrl);
    if (
        redirect.origin !== ORIGIN ||
        redirect.pathname.replace(/\/$/, "") !== new URL(resource.sourceUrl).pathname ||
        redirect.search ||
        redirect.hash ||
        redirect.username ||
        redirect.password
    ) {
        throw new Error(`Unexpected Workupload password redirect for ${resource.key}.`);
    }
    return await loadPage(
        kd,
        jar,
        redirect.href,
        `password redirect GET /${resource.kind}/${resource.key}`,
        resource.sourceUrl,
        signal,
    );
}

function parsePuzzle(value: unknown) {
    const envelope = asRecord(value);
    const data = asRecord(envelope?.data);
    const find = data?.find;
    if (
        envelope?.success !== true ||
        typeof data?.puzzle !== "string" ||
        !Number.isSafeInteger(data.range) ||
        (data.range as number) < 1 ||
        (data.range as number) > 1_000_000 ||
        !Array.isArray(find) ||
        find.length === 0 ||
        find.length > 32 ||
        !find.every((hash) => typeof hash === "string" && /^[a-f\d]{64}$/i.test(hash)) ||
        new Set(find).size !== find.length
    ) {
        throw new Error("Workupload puzzle returned an invalid response.");
    }
    return { puzzle: data.puzzle, range: data.range as number, find: find as string[] };
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
    }
}

async function solvePuzzle(puzzle: ReturnType<typeof parsePuzzle>, signal?: AbortSignal) {
    const answers = new Map<string, number>();
    const targets = new Set(puzzle.find);
    for (
        let start = 0;
        start < puzzle.range && answers.size < targets.size;
        start += PUZZLE_SEARCH_BATCH_SIZE
    ) {
        throwIfAborted(signal);
        const end = Math.min(start + PUZZLE_SEARCH_BATCH_SIZE, puzzle.range);
        for (let index = start; index < end && answers.size < targets.size; index += 1) {
            throwIfAborted(signal);
            const hash = crypto
                .createHash("sha256")
                .update(puzzle.puzzle + index)
                .digest("hex");
            if (targets.has(hash)) answers.set(hash, index);
        }
        if (answers.size < targets.size) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }
    throwIfAborted(signal);
    if (answers.size !== puzzle.find.length) {
        throw new Error(`Workupload puzzle solved ${answers.size}/${puzzle.find.length} hashes.`);
    }
    return `${puzzle.find.map((hash) => answers.get(hash)).join(" ")} `;
}

async function passSecurityCheck(
    kd: KioskDownloader,
    jar: CookieJar,
    referer: string,
    signal?: AbortSignal,
) {
    const puzzle = parsePuzzle(
        await readJson(
            await request(kd, jar, `${ORIGIN}/puzzle`, {
                headers: {
                    Accept: AJAX_ACCEPT,
                    Referer: referer,
                    "X-Requested-With": "XMLHttpRequest",
                },
                signal,
            }),
            "puzzle",
        ),
    );
    const response = await request(kd, jar, `${ORIGIN}/captcha`, {
        method: "POST",
        headers: {
            Accept: AJAX_ACCEPT,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Referer: referer,
            "X-Requested-With": "XMLHttpRequest",
        },
        body: new URLSearchParams({ captcha: await solvePuzzle(puzzle, signal) }),
        signal,
    });
    await readText(response, "captcha");
}

async function activateFileSession(
    kd: KioskDownloader,
    jar: CookieJar,
    fileUrl: string,
    startUrl: string,
    signal?: AbortSignal,
) {
    const first = await loadPage(kd, jar, startUrl, "activate GET /start/<key>", fileUrl, signal);
    if (first.includes("/api/file/getDownloadServer/")) return;
    await readText(
        await request(kd, jar, fileUrl, { headers: { Referer: startUrl }, signal }),
        "activate GET /file/<key>",
    );
    const second = await loadPage(
        kd,
        jar,
        startUrl,
        "activate retry GET /start/<key>",
        fileUrl,
        signal,
    );
    if (!second.includes("/api/file/getDownloadServer/")) {
        throw new Error("Workupload download session did not become active.");
    }
}
