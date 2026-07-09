import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { encode } from "cbor-x";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerFileMapping, UploadResponseDir } from "./types";

import {
    buildSegmentWorkItems,
    KioUploadClient,
    UploadSessionExpiredError,
} from "./kio-upload-client";

function response(files: Array<{ path: string; id: string; size: number }>): UploadResponseDir {
    const root: UploadResponseDir = { id: Buffer.alloc(16), name: "", files: [], children: [] };
    const dirs = new Map<string, UploadResponseDir>([["", root]]);
    for (const file of files) {
        const parts = file.path.split("/");
        const name = parts.pop() as string;
        let parent = root;
        let currentPath = "";
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const existing = dirs.get(currentPath);
            if (existing) {
                parent = existing;
                continue;
            }
            const dir: UploadResponseDir = {
                id: Buffer.alloc(16),
                name: part,
                files: [],
                children: [],
            };
            parent.children.push(dir);
            dirs.set(currentPath, dir);
            parent = dir;
        }
        parent.files.push({ id: Buffer.from(file.id, "hex"), name, size: file.size });
    }
    return root;
}

describe("buildSegmentWorkItems", () => {
    it("maps identical basenames by their full relative path", () => {
        const files = new Map([
            [
                "one/report.csv",
                {
                    path: "one/report.csv",
                    name: "report.csv",
                    size: 4,
                    fsPath: "C:/one/report.csv",
                    sourceMtimeMs: 1,
                },
            ],
            [
                "two/report.csv",
                {
                    path: "two/report.csv",
                    name: "report.csv",
                    size: 4,
                    fsPath: "C:/two/report.csv",
                    sourceMtimeMs: 2,
                },
            ],
        ]);

        const workItems = buildSegmentWorkItems(
            response([
                { path: "one/report.csv", id: "00112233445566778899aabbccddeeff", size: 4 },
                { path: "two/report.csv", id: "ffeeddccbbaa99887766554433221100", size: 4 },
            ]),
            files,
            16,
        );

        expect(workItems.map((item) => [item.relativePath, item.fsPath])).toEqual([
            ["one/report.csv", "C:/one/report.csv"],
            ["two/report.csv", "C:/two/report.csv"],
        ]);
    });

    it("rejects partial server mappings and size mismatches", () => {
        const files = new Map([
            [
                "one/a.txt",
                {
                    path: "one/a.txt",
                    name: "a.txt",
                    size: 2,
                    fsPath: "C:/one/a.txt",
                    sourceMtimeMs: 1,
                },
            ],
        ]);

        expect(() => buildSegmentWorkItems(response([]), files, 16)).toThrow("파일 수");
        expect(() =>
            buildSegmentWorkItems(
                response([{ path: "one/a.txt", id: "00112233445566778899aabbccddeeff", size: 3 }]),
                files,
                16,
            ),
        ).toThrow("크기");
    });
});

describe("KioUploadClient.uploadSegment", () => {
    const tempDirs: string[] = [];
    const httpRequest = vi.fn();

    afterEach(async () => {
        httpRequest.mockReset();
        await Promise.all(
            tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
        );
    });

    async function createSegmentFixture(content = "segment-bytes") {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kio-upload-segment-"));
        tempDirs.push(dir);
        const fsPath = path.join(dir, "file.bin");
        await fs.writeFile(fsPath, content);
        const stat = await fs.stat(fsPath);
        const item: ServerFileMapping = {
            fileId: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
            relativePath: "file.bin",
            size: stat.size,
            offset: 0,
            sequence: 2,
            length: stat.size,
            fsPath,
            sourceMtimeMs: Math.trunc(stat.mtimeMs),
        };
        return item;
    }

    function createClient() {
        return new KioUploadClient({
            http: { request: httpRequest },
        } as never);
    }

    function cborResponse(status: number, body: unknown) {
        if (body === undefined) {
            return {
                status,
                arrayBuffer: async () => new ArrayBuffer(0),
            };
        }
        const raw = Buffer.from(encode(body));
        return {
            status,
            arrayBuffer: async () =>
                raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
        };
    }

    function edgeResponse(ok: boolean, status = ok ? 200 : 500) {
        return {
            ok,
            status,
            text: async () => (ok ? "" : "edge-error"),
        };
    }

    it("returns length when segment already exists without edge PUT", async () => {
        const item = await createSegmentFixture();
        httpRequest.mockResolvedValueOnce(cborResponse(200, { exists: true }));

        const length = await createClient().uploadSegment(
            item,
            "token",
            new AbortController().signal,
        );

        expect(length).toBe(item.length);
        expect(httpRequest).toHaveBeenCalledTimes(1);
        expect(String(httpRequest.mock.calls[0]?.[0])).toContain("/segment/upload");
    });

    it("treats segment_hash_conflict as successful idempotent retry", async () => {
        const item = await createSegmentFixture();
        httpRequest.mockResolvedValueOnce(
            cborResponse(409, {
                code: "collection:segment_hash_conflict",
                message: "segment hash already exists for this sequence",
            }),
        );

        const length = await createClient().uploadSegment(
            item,
            "token",
            new AbortController().signal,
        );

        expect(length).toBe(item.length);
        expect(httpRequest).toHaveBeenCalledTimes(1);
    });

    it("uploads via edge PUT after segment/upload issues credentials", async () => {
        const item = await createSegmentFixture();
        httpRequest
            .mockResolvedValueOnce(
                cborResponse(200, {
                    exists: false,
                    data: { url: "https://edge.example", token: "edge-token" },
                }),
            )
            .mockResolvedValueOnce(edgeResponse(true));

        const length = await createClient().uploadSegment(
            item,
            "token",
            new AbortController().signal,
        );

        expect(length).toBe(item.length);
        expect(httpRequest).toHaveBeenCalledTimes(2);
        expect(String(httpRequest.mock.calls[1]?.[0])).toBe("https://edge.example/edge/v4/upload");
    });

    it("re-registers via segment/upload on the next attempt after edge failure", async () => {
        const item = await createSegmentFixture();
        const client = createClient();
        httpRequest
            .mockResolvedValueOnce(
                cborResponse(200, {
                    exists: false,
                    data: { url: "https://edge.example", token: "edge-token" },
                }),
            )
            .mockResolvedValueOnce(edgeResponse(false, 400))
            .mockResolvedValueOnce(
                cborResponse(409, {
                    code: "collection:segment_hash_conflict",
                    message: "segment hash already exists for this sequence",
                }),
            );

        await expect(
            client.uploadSegment(item, "token", new AbortController().signal),
        ).rejects.toThrow("edge PUT 실패: HTTP 400");

        const length = await client.uploadSegment(item, "token", new AbortController().signal);

        expect(length).toBe(item.length);
        expect(httpRequest).toHaveBeenCalledTimes(3);
        expect(String(httpRequest.mock.calls[2]?.[0])).toContain("/segment/upload");
    });

    it("still throws on non-idempotent fatal segment errors", async () => {
        const item = await createSegmentFixture();
        httpRequest.mockResolvedValueOnce(
            cborResponse(400, {
                code: "collection:invalid_segment_sequence",
                message: "bad sequence",
            }),
        );

        await expect(
            createClient().uploadSegment(item, "token", new AbortController().signal),
        ).rejects.toThrow("collection:invalid_segment_sequence");
    });

    it("maps missing collection on segment/upload to session expired", async () => {
        const item = await createSegmentFixture();
        httpRequest.mockResolvedValueOnce(
            cborResponse(404, {
                code: "collection:not_found",
                message: "gone",
            }),
        );

        await expect(
            createClient().uploadSegment(item, "token", new AbortController().signal),
        ).rejects.toBeInstanceOf(UploadSessionExpiredError);
    });
});
