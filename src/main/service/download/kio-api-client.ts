import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import { shareIdToUuidBytes, tryParseShareUrl } from "@shared/share-url";
import type {
    DirNode,
    LoadCollectionPayload,
    ProbeCollectionPayload,
    ProbeCollectionResult,
    TreeEntry,
} from "@shared/types";
import { isZipFileName } from "@shared/zip-tree";
import { decode, encode } from "cbor-x";

import type { KioskDownloader } from "../..";
import type {
    DownloadChunkRow,
    DownloadCollectionRow,
    LoadedCollection,
    SegmentDescriptor,
} from "./types";

const API_BASE_URL = "https://api.kio.ac";

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

function asMap(value: unknown) {
    if (value instanceof Map) {
        return value;
    }
    const record = asRecord(value);
    if (record) {
        return new Map(Object.entries(record));
    }
    throw new Error("Expected a map-like CBOR value.");
}

function uuidToHex(value: unknown) {
    return asBuffer(value).toString("hex");
}

function shareIdToUuid(shareId: string) {
    return Buffer.from(shareIdToUuidBytes(shareId));
}

function extractShareId(url: string) {
    const shareId = tryParseShareUrl(url);
    if (!shareId) {
        throw new Error("Invalid kio.ac share URL.");
    }
    return shareId;
}

export class KioApiClient {
    public constructor(private readonly kd: KioskDownloader) {}

    public async loadCollection(payload: LoadCollectionPayload): Promise<LoadedCollection> {
        const shareId = extractShareId(payload.url);
        const uuid = shareIdToUuid(shareId);
        const unlocked = await this.unlockCollection(uuid, payload.password);
        const tree = await this.buildTree(Buffer.from(unlocked.rootId, "hex"), unlocked.cat);

        return {
            collection: {
                shareId,
                name: unlocked.name,
                expires: unlocked.expires,
                segmentSize: unlocked.segmentSize,
                passwordProtected: unlocked.passwordProtected,
                tree,
            },
            cat: unlocked.cat,
            rootId: unlocked.rootId,
            passwordProtected: unlocked.passwordProtected,
        };
    }

    public async probeCollection(payload: ProbeCollectionPayload): Promise<ProbeCollectionResult> {
        const shareId = extractShareId(payload.url);
        const uuid = shareIdToUuid(shareId);
        const response = await this.cborPost(`${API_BASE_URL}/v0/collection/get`, { uuid });
        const body = asRecord(response.body);

        if (response.status === 200 && typeof body?.token === "string") {
            return { passwordRequired: false };
        }

        if (response.status !== 418) {
            throw new Error(`collection/get failed: HTTP ${response.status}`);
        }

        const meta = asRecord(body?.meta);
        if (meta?.type === "password") {
            return { passwordRequired: true };
        }

        throw new Error("Collection requires an unsupported protector.");
    }

    public async refreshCollectionToken(row: DownloadCollectionRow) {
        const uuid = shareIdToUuid(row.shareId);
        return this.unlockCollection(uuid, row.passwordPlain ?? undefined);
    }

    public async getSegments(remoteFileId: string, cat: string): Promise<SegmentDescriptor[]> {
        const response = await this.cborPost(
            `${API_BASE_URL}/v0/collection/file/gets`,
            { ids: [Buffer.from(remoteFileId, "hex")] },
            {
                "Kiosk-CAT": cat,
                "Kiosk-Download-Capability": "cdn, edge",
            },
        );
        const body = asRecord(response.body);
        const files = Array.isArray(body?.files) ? body.files : [];
        const firstFile = asRecord(files[0]);
        const segments = Array.isArray(firstFile?.segments) ? firstFile.segments : [];

        if (response.status !== 200 || segments.length === 0) {
            throw new Error(`file/gets failed: HTTP ${response.status}`);
        }

        return segments.map((segment): SegmentDescriptor => {
            const record = asRecord(segment);
            if (!record) {
                throw new Error("Invalid segment descriptor.");
            }
            const type = record?.type;
            if (type !== "cdn" && type !== "edge") {
                throw new Error(`Unknown segment type: ${String(type)}`);
            }
            return {
                type,
                data: asMap(record.data),
            };
        });
    }

    public streamSegment(segment: SegmentDescriptor, chunk: DownloadChunkRow, signal: AbortSignal) {
        return streamSegmentBytes(this.kd, segment, 0, chunk.size, signal, {
            label: `Segment ${chunk.chunkIndex}`,
            mode: "full",
        });
    }

    /**
     * Read [localStart, localEnd) from a segment body.
     * Uses a full segment GET (no Range) so edge/CDN paths match normal file downloads;
     * unused prefix/suffix within the segment are skipped and the body is cancelled early.
     */
    public streamSegmentRange(
        segment: SegmentDescriptor,
        range: { localStart: number; localEnd: number },
        signal: AbortSignal,
    ) {
        return streamSegmentBytes(this.kd, segment, range.localStart, range.localEnd, signal, {
            label: "Segment range",
            mode: "slice",
        });
    }

    private async unlockCollection(uuid: Buffer, password?: string) {
        const first = await this.cborPost(`${API_BASE_URL}/v0/collection/get`, { uuid });
        const firstBody = asRecord(first.body);

        if (first.status === 200 && typeof firstBody?.token === "string") {
            return this.parseCollectionResponse(firstBody, false);
        }

        if (first.status !== 418) {
            throw new Error(`collection/get failed: HTTP ${first.status}`);
        }

        const meta = asRecord(firstBody?.meta);
        if (!password) {
            if (meta?.type === "password") {
                throw new Error(COLLECTION_PASSWORD_REQUIRED_ERROR);
            }
            throw new Error("Collection requires an unsupported protector.");
        }
        if (meta?.type !== "password") {
            throw new Error(`Unsupported collection protector: ${String(meta?.type)}`);
        }

        const second = await this.cborPost(`${API_BASE_URL}/v0/collection/get`, {
            uuid,
            protector: [{ type: "password", data: new Map([["password", password]]) }],
        });
        const secondBody = asRecord(second.body);

        if (second.status !== 200 || typeof secondBody?.token !== "string") {
            if (secondBody?.code === "collection:invalid_protector_config") {
                throw new Error(COLLECTION_INVALID_PASSWORD_ERROR);
            }
            throw new Error(`collection/get failed: HTTP ${second.status}`);
        }

        return this.parseCollectionResponse(secondBody, true);
    }

    private parseCollectionResponse(body: Record<string, unknown>, passwordProtected: boolean) {
        if (typeof body.name !== "string" || typeof body.token !== "string") {
            throw new Error("Invalid collection/get response.");
        }

        return {
            name: body.name,
            cat: body.token,
            rootId: uuidToHex(body.root),
            segmentSize: Number(body.segment_size),
            expires: Number(body.expires),
            passwordProtected,
        };
    }

    private async buildTree(rootId: Buffer, cat: string) {
        const buildDir = async (id: Buffer, name: string): Promise<DirNode> => {
            const response = await this.cborPost(
                `${API_BASE_URL}/v0/collection/directory/get`,
                { id },
                { "Kiosk-CAT": cat },
            );
            const body = asRecord(response.body);
            if (response.status !== 200 || !body) {
                throw new Error(`directory/get failed for "${name}": HTTP ${response.status}`);
            }

            const files = (Array.isArray(body.files) ? body.files : []).map((file) => {
                const record = asRecord(file);
                if (!record || typeof record.name !== "string") {
                    throw new Error("Invalid file node in directory/get response.");
                }
                const name = record.name;
                const id = uuidToHex(record.id);
                const size = Number(record.size);
                if (isZipFileName(name)) {
                    return {
                        kind: "zip" as const,
                        node: {
                            type: "zip" as const,
                            id,
                            name,
                            size,
                            entries: null,
                        },
                    };
                }
                return {
                    kind: "file" as const,
                    node: {
                        type: "file" as const,
                        id,
                        name,
                        size,
                    },
                };
            });

            const childDirs = await Promise.all(
                (Array.isArray(body.children) ? body.children : []).map(async (child) => {
                    const record = asRecord(child);
                    if (!record || typeof record.name !== "string") {
                        throw new Error("Invalid directory node in directory/get response.");
                    }
                    return buildDir(asBuffer(record.id), record.name);
                }),
            );

            const entries: TreeEntry[] = [
                ...childDirs.map((node) => ({ kind: "dir" as const, node })),
                ...files,
            ];
            return {
                type: "dir",
                id: id.toString("hex"),
                name,
                entries,
            };
        };

        return await buildDir(rootId, "");
    }

    private async cborPost(
        url: string,
        bodyObj: unknown,
        headers: Record<string, string> = {},
    ): Promise<CborResponse> {
        const body = Buffer.from(encode(bodyObj));
        const response = await this.kd.http.request(url, {
            method: "POST",
            headers: {
                "content-type": "application/cbor",
                accept: "application/cbor",
                ...headers,
            },
            body: body as BodyInit,
        });
        const raw = Buffer.from(await response.arrayBuffer());

        let decoded: unknown = null;
        try {
            decoded = decode(raw);
        } catch {
            decoded = null;
        }

        return {
            status: response.status,
            raw,
            body: decoded,
        };
    }
}

function resolveSegmentRequest(segment: SegmentDescriptor) {
    const headers: Record<string, string> = {};
    let url: string;

    if (segment.type === "edge") {
        const baseUrl = segment.data.get("url");
        const token = segment.data.get("token");
        if (typeof baseUrl !== "string" || typeof token !== "string") {
            throw new Error("edge segment is missing url/token.");
        }
        url = `${baseUrl}/edge/v4/download`;
        headers["Kiosk-SAT"] = token;
    } else {
        const cdnUrl = segment.data.get("url");
        if (typeof cdnUrl !== "string") {
            throw new Error("cdn segment is missing url.");
        }
        url = cdnUrl;
    }

    return { url, headers };
}

export async function* streamSegmentBytes(
    kd: KioskDownloader,
    segment: SegmentDescriptor,
    localStart: number,
    localEnd: number,
    signal: AbortSignal,
    options: { label: string; mode: "full" | "range" | "slice" },
): AsyncGenerator<Uint8Array> {
    const expected = localEnd - localStart;
    if (expected <= 0) {
        return;
    }

    const { url, headers } = resolveSegmentRequest(segment);
    if (options.mode === "range") {
        headers.Range = `bytes=${localStart}-${localEnd - 1}`;
    }

    const response = await kd.http.request(url, {
        headers,
        signal,
        timeout: false,
    });

    if (response.status !== 200 && response.status !== 206) {
        throw new Error(`${options.label} HTTP ${response.status}`);
    }

    if (!response.body) {
        throw new Error(`${options.label} response has no body.`);
    }

    const reader = response.body.getReader();
    // slice: body is a full segment from local 0. range+200: server ignored Range and sent
    // the full segment/file from 0 — skip to localStart. Always cancel when done so a 200
    // full-archive body cannot keep downloading after we have the bytes we need.
    const skip =
        options.mode === "slice" || (options.mode === "range" && response.status === 200)
            ? localStart
            : 0;
    let skipped = 0;
    let yielded = 0;
    const quantumSize = 64 * 1024;

    try {
        while (yielded < expected) {
            if (signal.aborted) {
                throw new DOMException("The operation was aborted.", "AbortError");
            }

            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!value || value.length === 0) {
                continue;
            }

            let slice = value;
            if (skipped < skip) {
                const remainSkip = skip - skipped;
                if (slice.length <= remainSkip) {
                    skipped += slice.length;
                    await kd.service.transfer.downloadBandwidth.take(slice.length, signal);
                    continue;
                }
                const skippedPiece = slice.subarray(0, remainSkip);
                await kd.service.transfer.downloadBandwidth.take(skippedPiece.length, signal);
                slice = slice.subarray(remainSkip);
                skipped = skip;
            }

            const remaining = expected - yielded;
            if (slice.length > remaining) {
                slice = slice.subarray(0, remaining);
            }

            let offset = 0;
            while (offset < slice.length) {
                if (signal.aborted) {
                    throw new DOMException("The operation was aborted.", "AbortError");
                }
                const end = Math.min(offset + quantumSize, slice.length);
                const quantum = slice.subarray(offset, end);
                await kd.service.transfer.downloadBandwidth.take(quantum.length, signal);
                yielded += quantum.length;
                offset = end;
                yield quantum;
            }
        }
    } finally {
        // Stop further network transfer (critical when server returns 200 with a huge body).
        await reader.cancel().catch(() => undefined);
    }

    if (signal.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
    }

    if (yielded < expected) {
        throw new Error(`${options.label} returned ${yielded}B, expected ${expected}B.`);
    }
}
