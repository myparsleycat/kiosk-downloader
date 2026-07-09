import crypto from "node:crypto";
import fs from "node:fs";

import { uuidBytesToShareId } from "@shared/share-url";
import type { UploadOptions, UploadTreeFile } from "@shared/types";
import { decode, encode } from "cbor-x";

import type { KioskDownloader } from "../..";
import type {
    CreatedUpload,
    ServerFileMapping,
    UploadRequestDir,
    UploadResponseDir,
} from "./types";

import { UPLOAD_SEGMENT_SIZE } from "./types";

const API_BASE_URL = "https://api.kio.ac";

const EDGE_PUT_MAX_ATTEMPTS = 5;
const EDGE_PUT_RETRY_BACKOFF_MAX_MS = 5000;

type CborResponse = {
    status: number;
    raw: Buffer;
    body: unknown;
};

function asBuffer(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value);
    }
    if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        "data" in value &&
        (value as { type: unknown }).type === "Buffer" &&
        Array.isArray((value as { data: unknown }).data)
    ) {
        return Buffer.from((value as { data: number[] }).data);
    }
    throw new Error("Expected a buffer-like CBOR value.");
}

function asRecord(value: unknown) {
    if (!value || typeof value !== "object") {
        return null;
    }
    return value as Record<string, unknown>;
}

function randomUuidBytes(): Buffer {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 1
    return b;
}

// Local tree builder — mirrors kio_uploader.js buildTree/buildDir.
// Each node gets a client-minted UUID; the server discards these and
// reassigns its own in the create response.
type BuiltTree = {
    root: UploadRequestDir;
    fsPathByFileKey: Map<string, string>;
};

function buildRequestTree(files: UploadTreeFile[]): BuiltTree {
    // A lone file (no parent dir) is wrapped as a root dir with an empty name,
    // matching how the web client wraps a FileSystemFileHandle.
    const fsPathByFileKey = new Map<string, string>();
    const root: UploadRequestDir = {
        id: randomUuidBytes(),
        name: "",
        files: [],
        children: [],
    };

    type DirBuilder = UploadRequestDir & { __path: string };
    const dirsByPath = new Map<string, DirBuilder>();
    dirsByPath.set("", { ...root, __path: "" });

    const ensureDir = (segments: string[]): DirBuilder => {
        const dirPath = segments.join("/");
        const existing = dirsByPath.get(dirPath);
        if (existing) {
            return existing;
        }

        const parentSegments = segments.slice(0, -1);
        const parent = ensureDir(parentSegments);
        const dir: DirBuilder = {
            id: randomUuidBytes(),
            name: segments[segments.length - 1],
            files: [],
            children: [],
            __path: dirPath,
        };
        dirsByPath.set(dirPath, dir);
        parent.children.push(stripInternal(dir));
        return dir;
    };

    for (const file of files) {
        const normalized = file.path.split("/").filter(Boolean);
        const dirSegments = normalized.slice(0, -1);
        const fileName = normalized[normalized.length - 1] ?? file.name;
        const dir = ensureDir(dirSegments);

        const fileId = randomUuidBytes();
        dir.files.push({ id: fileId, name: fileName, size: file.size });
        fsPathByFileKey.set(fileId.toString("hex"), file.fsPath);
    }

    return { root: stripInternal(root), fsPathByFileKey };
}

function stripInternal(dir: UploadRequestDir & { __path?: string }): UploadRequestDir {
    const { id, name, files, children } = dir;
    return { id, name, files, children };
}

// Server tree indexing — map server file ids back to on-disk paths by matching
// the (identical) name tree between request and response.
function indexResponseTree(
    node: UploadResponseDir,
    prefix: string[],
    out: Map<string, { id: Buffer; size: number }>,
) {
    for (const file of node.files ?? []) {
        out.set([...prefix, file.name].join("/"), {
            id: asBuffer(file.id),
            size: Number(file.size),
        });
    }
    for (const child of node.children ?? []) {
        indexResponseTree(child, [...prefix, child.name], out);
    }
}

export function buildSegmentWorkItems(
    responseRoot: UploadResponseDir,
    fsPathByFileKey: Map<string, string>,
    segmentSize: number,
): ServerFileMapping[] {
    const serverByPath = new Map<string, { id: Buffer; size: number }>();
    indexResponseTree(responseRoot, [], serverByPath);

    const items: ServerFileMapping[] = [];
    for (const [filePath, { id: fileId, size }] of serverByPath) {
        const fsPath =
            fsPathByFileKey.get(filePath) ?? findFsPathByBasename(fsPathByFileKey, filePath);
        if (!fsPath) {
            continue;
        }

        if (size === 0) {
            items.push({ fileId, size, offset: 0, sequence: 0, length: 0, fsPath });
            continue;
        }

        for (let offset = 0, seq = 0; offset < size; offset += segmentSize, seq += 1) {
            items.push({
                fileId,
                size,
                offset,
                sequence: seq,
                length: Math.min(segmentSize, size - offset),
                fsPath,
            });
        }
    }
    return items;
}

function findFsPathByBasename(fsPathByFileKey: Map<string, string>, filePath: string) {
    const basename = filePath.split("/").pop();
    if (!basename) {
        return undefined;
    }
    for (const fsPath of fsPathByFileKey.values()) {
        if (fsPath.endsWith(basename)) {
            return fsPath;
        }
    }
    return undefined;
}

export class KioUploadClient {
    public constructor(private readonly kd: KioskDownloader) {}

    public async createCollection(
        files: UploadTreeFile[],
        options: UploadOptions,
        turnstileToken: string,
    ): Promise<CreatedUpload & { workItems: ServerFileMapping[] }> {
        const { root, fsPathByFileKey } = buildRequestTree(files);

        const protector = options.password
            ? [{ type: "password", data: new Map([["password", options.password]]) }]
            : [];

        const body = {
            name: options.name.slice(0, 100),
            description: options.description.slice(0, 2500),
            protector,
            root,
            segment_size: UPLOAD_SEGMENT_SIZE,
            eternal: options.eternal,
            expires: new Date(options.expires),
        };

        const response = await this.cborRequest(
            "POST",
            `${API_BASE_URL}/v0/collection/create`,
            body,
            {
                "Kiosk-Upload-Preference": "",
                "Request-Integrity-Token": turnstileToken,
            },
        );

        if (response.status !== 200 || !response.body) {
            const errorBody = asRecord(response.body) ?? {};
            throw new Error(
                `collection/create 실패: HTTP ${response.status} ${JSON.stringify(errorBody)}`,
            );
        }

        const parsed = asRecord(response.body);
        const collectionUuid = asBuffer(parsed?.id);
        const uploadToken = parsed?.token;
        const responseRoot = parsed?.root as UploadResponseDir | undefined;

        if (!collectionUuid || typeof uploadToken !== "string") {
            throw new Error(
                `collection/create 응답에 id/token이 없습니다: ${JSON.stringify(parsed)}`,
            );
        }
        if (!responseRoot) {
            throw new Error("collection/create 응답에 root가 없습니다.");
        }

        const workItems = buildSegmentWorkItems(responseRoot, fsPathByFileKey, UPLOAD_SEGMENT_SIZE);
        if (workItems.length === 0) {
            throw new Error("서버 파일 id 매핑에 실패했습니다. 트리 구조를 확인하세요.");
        }

        return { collectionUuid, uploadToken, root: responseRoot, workItems };
    }

    // Per-segment: SHA-256 → segment/upload → (if !exists) edge PUT.
    public async uploadSegment(
        item: ServerFileMapping,
        uploadToken: string,
        signal: AbortSignal,
    ): Promise<number> {
        const bytes =
            item.length > 0
                ? readSegmentBytes(item.fsPath, item.offset, item.length)
                : Buffer.alloc(0);
        const hash = crypto.createHash("sha256").update(bytes).digest();

        const segBody = {
            file_id: item.fileId,
            hash,
            segment_sequence: item.sequence,
        };

        const response = await this.cborRequest(
            "PUT",
            `${API_BASE_URL}/v0/collection/file/segment/upload`,
            segBody,
            { "Kiosk-Upload-Capability": "edge", "Kiosk-UT": uploadToken },
        );

        if (response.status !== 200 || !response.body) {
            const errorBody = asRecord(response.body) ?? {};
            const code = typeof errorBody.code === "string" ? errorBody.code : "";
            if (
                [
                    "collection:not_found",
                    "collection:segment_hash_conflict",
                    "collection:invalid_segment_sequence",
                    "collection:no_available_upload_method",
                    "invalid_request",
                ].includes(code)
            ) {
                const errorMessage = typeof errorBody.message === "string" ? errorBody.message : "";
                throw new Error(`segment/upload 치명적 오류: ${code} — ${errorMessage}`);
            }
            throw new Error(
                `segment/upload 실패: HTTP ${response.status} ${JSON.stringify(errorBody)}`,
            );
        }

        const segResp = asRecord(response.body);
        if (segResp?.exists) {
            return item.length; // dedup: server already has this segment
        }

        const data = asRecord(segResp?.data);
        const url = data?.url;
        const edgeToken = data?.token;
        if (typeof url !== "string" || typeof edgeToken !== "string") {
            throw new Error(
                `segment/upload 응답에 data.url/data.token이 없습니다: ${JSON.stringify(segResp)}`,
            );
        }

        await this.edgePut(url, edgeToken, bytes, signal);
        return item.length;
    }

    private async edgePut(baseUrl: string, token: string, bytes: Buffer, signal: AbortSignal) {
        const putUrl = `${baseUrl.replace(/\/$/, "")}/edge/v4/upload`;

        for (let attempt = 1; attempt <= EDGE_PUT_MAX_ATTEMPTS; attempt += 1) {
            if (signal.aborted) {
                throw new DOMException("The operation was aborted.", "AbortError");
            }

            const response = await this.kd.http.request(putUrl, {
                method: "PUT",
                body: bytes as BodyInit,
                headers: { "Kiosk-ESUT": token },
                signal,
                retry: { limit: 0 },
            });

            if (response.ok) {
                return;
            }

            const text = await response.text().catch(() => "");

            if (response.status !== 403 && response.status < 500) {
                throw new Error(`edge PUT 실패: HTTP ${response.status} ${text}`);
            }

            if (attempt >= EDGE_PUT_MAX_ATTEMPTS) {
                throw new Error(
                    `edge PUT 실패 (${EDGE_PUT_MAX_ATTEMPTS}회 시도 후): HTTP ${response.status} ${text}`,
                );
            }

            const delay = Math.min(1000 * 2 ** (attempt - 1), EDGE_PUT_RETRY_BACKOFF_MAX_MS);
            this.kd.logger.warn(
                {
                    channel: "edge-put",
                    stage: "retry",
                    attempt,
                    maxAttempts: EDGE_PUT_MAX_ATTEMPTS,
                    status: response.status,
                    delayMs: delay,
                    message: text,
                },
                "UploadService:edgePut",
            );
            await sleepWithAbort(delay, signal);
        }
    }

    public async completeCollection(uploadToken: string): Promise<void> {
        const response = await this.cborRequest(
            "POST",
            `${API_BASE_URL}/v0/collection/complete`,
            undefined,
            { "Kiosk-UT": uploadToken },
        );

        // 200 (CBOR body) or 204 (no content) both mean success.
        if (response.status !== 200 && response.status !== 204) {
            const errorBody = asRecord(response.body) ?? {};
            throw new Error(
                `collection/complete 실패: HTTP ${response.status} ${JSON.stringify(errorBody)}`,
            );
        }
    }

    public static buildShareLink(collectionUuid: Buffer): string {
        const shareId = uuidBytesToShareId(collectionUuid);
        return `https://kio.ac/c/${shareId}`;
    }

    private async cborRequest(
        method: string,
        url: string,
        bodyObj: unknown,
        headers: Record<string, string> = {},
    ): Promise<CborResponse> {
        const init: Record<string, unknown> = {
            method,
            headers: {
                "content-type": "application/cbor",
                accept: "application/cbor",
                ...headers,
            },
        };

        if (bodyObj !== undefined) {
            init.body = Buffer.from(encode(bodyObj)) as BodyInit;
        }

        const response = await this.kd.http.request(url, init);
        const raw = Buffer.from(await response.arrayBuffer());

        let decoded: unknown = null;
        if (raw.length > 0) {
            try {
                decoded = decode(raw);
            } catch {
                decoded = null;
            }
        }

        return {
            status: response.status,
            raw,
            body: decoded,
        };
    }
}

function readSegmentBytes(fsPath: string, offset: number, length: number): Buffer {
    const fd = fs.openSync(fsPath, "r");
    try {
        const buf = Buffer.alloc(length);
        if (length > 0) {
            fs.readSync(fd, buf, 0, length, offset);
        }
        return buf;
    } finally {
        fs.closeSync(fd);
    }
}

function sleepWithAbort(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
        }

        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

export { UPLOAD_SEGMENT_SIZE };
