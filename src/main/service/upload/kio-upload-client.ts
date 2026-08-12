import crypto from "node:crypto";
import fs from "node:fs/promises";

import { uuidBytesToShareId } from "@shared/share-url";
import type { UploadOptions } from "@shared/types";
import { decode, encode } from "cbor-x";

import type { KioskDownloader } from "../..";
import type {
    CreatedUpload,
    ServerFileMapping,
    UploadRequestDir,
    UploadResponseDir,
    UploadSourceFile,
} from "./types";

import { UPLOAD_SEGMENT_SIZE } from "./types";

const API_BASE_URL = "https://api.kio.ac";

const UPLOAD_STREAM_CHUNK_SIZE = 64 * 1024;

type CborResponse = {
    status: number;
    raw: Buffer;
    body: unknown;
};

export class UploadSessionExpiredError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "UploadSessionExpiredError";
    }
}

export class UploadSourceChangedError extends Error {
    public constructor(fsPath: string) {
        super(`업로드 원본 파일이 변경되었거나 읽을 수 없습니다: ${fsPath}`);
        this.name = "UploadSourceChangedError";
    }
}

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

function createUploadStream(
    bytes: Buffer,
    limiter: { take: (bytes: number, signal?: AbortSignal) => Promise<void> },
    signal: AbortSignal,
) {
    let offset = 0;
    let takeAbort: AbortController | null = null;

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (offset >= bytes.length) {
                controller.close();
                return;
            }

            if (signal.aborted) {
                controller.error(new DOMException("The operation was aborted.", "AbortError"));
                return;
            }

            const nextOffset = Math.min(offset + UPLOAD_STREAM_CHUNK_SIZE, bytes.length);
            const chunk = bytes.subarray(offset, nextOffset);
            takeAbort = new AbortController();
            const onAbort = () => takeAbort?.abort();
            signal.addEventListener("abort", onAbort, { once: true });
            try {
                await limiter.take(chunk.length, takeAbort.signal);
                if (signal.aborted) {
                    controller.error(new DOMException("The operation was aborted.", "AbortError"));
                    return;
                }
                controller.enqueue(chunk);
                offset = nextOffset;
            } catch (error) {
                controller.error(
                    error instanceof Error
                        ? error
                        : new DOMException("The operation was aborted.", "AbortError"),
                );
            } finally {
                signal.removeEventListener("abort", onAbort);
                takeAbort = null;
            }
        },
        cancel() {
            takeAbort?.abort();
        },
    });
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
    filesByRelativePath: Map<string, UploadSourceFile>;
};

function buildRequestTree(files: UploadSourceFile[]): BuiltTree {
    // A lone file (no parent dir) is wrapped as a root dir with an empty name,
    // matching how the web client wraps a FileSystemFileHandle.
    const filesByRelativePath = new Map<string, UploadSourceFile>();
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
        const relativePath = normalized.join("/");
        if (!relativePath) {
            throw new Error(`업로드 경로가 비어 있습니다: ${file.fsPath}`);
        }
        if (filesByRelativePath.has(relativePath)) {
            throw new Error(`업로드 경로가 중복됩니다: ${relativePath}`);
        }
        const dirSegments = normalized.slice(0, -1);
        const fileName = normalized[normalized.length - 1] ?? file.name;
        const dir = ensureDir(dirSegments);

        const fileId = randomUuidBytes();
        // Server CreateRequest expects CBOR uint64 (bigint), not JS number.
        dir.files.push({ id: fileId, name: fileName, size: BigInt(file.size) });
        filesByRelativePath.set(relativePath, { ...file, path: relativePath });
    }

    return { root: stripInternal(root), filesByRelativePath };
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
        const relativePath = [...prefix, file.name].join("/");
        if (out.has(relativePath)) {
            throw new Error(`서버 응답에 중복 파일 경로가 있습니다: ${relativePath}`);
        }
        out.set(relativePath, {
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
    filesByRelativePath: Map<string, UploadSourceFile>,
    segmentSize: number,
): ServerFileMapping[] {
    const serverByPath = new Map<string, { id: Buffer; size: number }>();
    indexResponseTree(responseRoot, [], serverByPath);

    if (serverByPath.size !== filesByRelativePath.size) {
        throw new Error("서버 응답 파일 수가 선택한 파일 수와 일치하지 않습니다.");
    }

    const items: ServerFileMapping[] = [];
    for (const [filePath, { id: fileId, size }] of serverByPath) {
        const localFile = filesByRelativePath.get(filePath);
        if (!localFile) {
            throw new Error(`서버 응답 파일을 로컬 경로와 연결할 수 없습니다: ${filePath}`);
        }
        if (size !== localFile.size) {
            throw new Error(`서버 응답 파일 크기가 일치하지 않습니다: ${filePath}`);
        }

        if (size === 0) {
            items.push({
                fileId,
                relativePath: filePath,
                size,
                offset: 0,
                sequence: 0,
                length: 0,
                fsPath: localFile.fsPath,
                sourceMtimeMs: localFile.sourceMtimeMs,
                sourceOffset: localFile.sourceOffset ?? 0,
                sourceSize: localFile.logicalSize ?? localFile.size,
            });
            continue;
        }

        for (let offset = 0, seq = 0; offset < size; offset += segmentSize, seq += 1) {
            items.push({
                fileId,
                relativePath: filePath,
                size,
                offset,
                sequence: seq,
                length: Math.min(segmentSize, size - offset),
                fsPath: localFile.fsPath,
                sourceMtimeMs: localFile.sourceMtimeMs,
                sourceOffset: localFile.sourceOffset ?? 0,
                sourceSize: localFile.logicalSize ?? localFile.size,
            });
        }
    }

    for (const filePath of filesByRelativePath.keys()) {
        if (!serverByPath.has(filePath)) {
            throw new Error(`서버 응답에 선택한 파일이 없습니다: ${filePath}`);
        }
    }

    return items;
}

export class KioUploadClient {
    public constructor(private readonly kd: KioskDownloader) {}

    public async createCollection(
        files: UploadSourceFile[],
        options: UploadOptions,
        turnstileToken: string,
    ): Promise<CreatedUpload & { workItems: ServerFileMapping[] }> {
        const { root, filesByRelativePath } = buildRequestTree(files);

        const protector = options.password
            ? [{ type: "password", data: new Map([["password", options.password]]) }]
            : [];

        const body = {
            name: options.name.slice(0, 100),
            description: options.description.slice(0, 2500),
            protector,
            root,
            segment_size: BigInt(UPLOAD_SEGMENT_SIZE),
            eternal: false,
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

        const workItems = buildSegmentWorkItems(
            responseRoot,
            filesByRelativePath,
            UPLOAD_SEGMENT_SIZE,
        );
        if (workItems.length === 0) {
            throw new Error("서버 파일 id 매핑에 실패했습니다. 트리 구조를 확인하세요.");
        }

        return { collectionUuid, uploadToken, root: responseRoot, workItems };
    }

    // Resume walks every sequence from 0; the server returns exists for stored segments.
    public async uploadSegment(
        item: ServerFileMapping,
        uploadToken: string,
        signal: AbortSignal,
        onProgress?: (transferredBytes: number) => void,
    ): Promise<{ length: number; outcome: "exists" | "conflict" | "uploaded" }> {
        const bytes = await readSegmentBytes(item);
        const hash = crypto.createHash("sha256").update(bytes).digest();

        const response = await this.cborRequest(
            "PUT",
            `${API_BASE_URL}/v0/collection/file/segment/upload`,
            {
                file_id: item.fileId,
                hash,
                segment_sequence: item.sequence,
            },
            { "Kiosk-Upload-Capability": "edge", "Kiosk-UT": uploadToken },
        );

        if (response.status !== 200 || !response.body) {
            const errorBody = asRecord(response.body) ?? {};
            const code = typeof errorBody.code === "string" ? errorBody.code : "";
            const errorMessage = typeof errorBody.message === "string" ? errorBody.message : "";
            if (
                code === "collection:not_found" ||
                response.status === 401 ||
                response.status === 403
            ) {
                throw new UploadSessionExpiredError(
                    `업로드 세션이 만료되었거나 더 이상 존재하지 않습니다: ${errorMessage}`,
                );
            }
            // Hash already bound for this sequence (e.g. retry after a partial edge attempt).
            if (code === "collection:segment_hash_conflict") {
                return { length: item.length, outcome: "conflict" };
            }
            if (
                [
                    "collection:invalid_segment_sequence",
                    "collection:no_available_upload_method",
                    "invalid_request",
                ].includes(code)
            ) {
                throw new Error(`segment/upload 치명적 오류: ${code} — ${errorMessage}`);
            }
            throw new Error(
                `segment/upload 실패: HTTP ${response.status} ${JSON.stringify(errorBody)}`,
            );
        }

        const segResp = asRecord(response.body);
        if (segResp?.exists) {
            return { length: item.length, outcome: "exists" };
        }

        const data = asRecord(segResp?.data);
        const url = data?.url;
        const edgeToken = data?.token;
        if (typeof url !== "string" || typeof edgeToken !== "string") {
            throw new Error(
                `segment/upload 응답에 data.url/data.token이 없습니다: ${JSON.stringify(segResp)}`,
            );
        }

        await this.edgePut(url, edgeToken, bytes, signal, onProgress);
        return { length: item.length, outcome: "uploaded" };
    }

    private async edgePut(
        baseUrl: string,
        token: string,
        bytes: Buffer,
        signal: AbortSignal,
        onProgress?: (transferredBytes: number) => void,
    ) {
        const putUrl = `${baseUrl.replace(/\/$/, "")}/edge/v4/upload`;

        if (signal.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }

        onProgress?.(0);
        const response = await this.kd.http.request(putUrl, {
            method: "PUT",
            body: createUploadStream(bytes, this.kd.service.transfer.uploadBandwidth, signal),
            headers: {
                "Content-Length": bytes.byteLength.toString(),
                "Kiosk-ESUT": token,
            },
            signal,
            timeout: false,
            retry: { limit: 0 },
            onUploadProgress: (progress) => {
                onProgress?.(progress.transferredBytes);
            },
        });

        if (response.ok) {
            return;
        }

        const text = await response.text().catch(() => "");
        throw new Error(`edge PUT 실패: HTTP ${response.status} ${text}`);
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
            const code = typeof errorBody.code === "string" ? errorBody.code : "";
            if (
                code === "collection:not_found" ||
                response.status === 401 ||
                response.status === 403
            ) {
                throw new UploadSessionExpiredError(
                    "업로드 세션이 만료되었거나 더 이상 존재하지 않습니다.",
                );
            }
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

async function readSegmentBytes(item: ServerFileMapping): Promise<Buffer> {
    const stat = await fs.stat(item.fsPath).catch(() => null);
    const sourceSize = item.sourceSize ?? item.size;
    if (
        !stat?.isFile() ||
        stat.size !== sourceSize ||
        Math.trunc(stat.mtimeMs) !== item.sourceMtimeMs
    ) {
        throw new UploadSourceChangedError(item.fsPath);
    }

    const handle = await fs.open(item.fsPath, "r");
    try {
        const afterOpen = await handle.stat();
        if (afterOpen.size !== sourceSize || Math.trunc(afterOpen.mtimeMs) !== item.sourceMtimeMs) {
            throw new UploadSourceChangedError(item.fsPath);
        }

        const bytes = Buffer.alloc(item.length);
        let total = 0;
        while (total < item.length) {
            const { bytesRead } = await handle.read(
                bytes,
                total,
                item.length - total,
                (item.sourceOffset ?? 0) + item.offset + total,
            );
            if (bytesRead === 0) {
                throw new UploadSourceChangedError(item.fsPath);
            }
            total += bytesRead;
        }
        return bytes;
    } finally {
        await handle.close();
    }
}

export { UPLOAD_SEGMENT_SIZE };
