import type { DirNode } from "@shared/types";
import { describe, expect, it } from "vitest";

import type { KioskDownloader } from "../..";

import { DatabaseClient } from "../../lib/db/client";
import { DownloadRepository, flattenDownloadTree } from "./repository";
import { TRANSFER_CHUNK_SIZE, transferChunkSizes } from "./transfer-it-crypto";

describe("flattenDownloadTree", () => {
    it("keeps unselected ZIP entries so they can be included later", () => {
        const tree: DirNode = {
            type: "dir",
            id: "root",
            name: "",
            entries: [
                {
                    kind: "zip",
                    node: {
                        type: "zip",
                        id: "archive",
                        name: "archive.zip",
                        size: 7_000,
                        entries: [
                            {
                                kind: "file",
                                node: {
                                    type: "file",
                                    id: "selected",
                                    name: "selected.bin",
                                    size: 1_000,
                                    zipEntry: {
                                        path: "selected.bin",
                                        compressionMethod: 8,
                                        compressedSize: 500,
                                        uncompressedSize: 1_000,
                                        offset: 0,
                                        encrypted: false,
                                    },
                                },
                            },
                            {
                                kind: "file",
                                node: {
                                    type: "file",
                                    id: "excluded",
                                    name: "excluded.bin",
                                    size: 6_000,
                                    zipEntry: {
                                        path: "excluded.bin",
                                        compressionMethod: 8,
                                        compressedSize: 3_000,
                                        uncompressedSize: 6_000,
                                        offset: 500,
                                        encrypted: false,
                                    },
                                },
                            },
                        ],
                    },
                },
            ],
        };

        expect(
            flattenDownloadTree(tree, new Set(["archive.zip/selected.bin"]), undefined),
        ).toMatchObject([
            { path: "archive.zip/selected.bin", selected: true },
            { path: "archive.zip/excluded.bin", selected: false },
        ]);
    });
});

async function createRepository() {
    const db = new DatabaseClient(":memory:");
    await db.reconcile();
    const repo = new DownloadRepository({ lib: { db } } as KioskDownloader);
    return { db, repo };
}

function seedTransferFile(
    db: DatabaseClient,
    options: {
        fileSize: number;
        chunks: Array<{
            chunkIndex: number;
            offset: number;
            size: number;
            status: string;
            downloadedBytes: number;
        }>;
        fileDownloadedBytes?: number;
    },
) {
    const now = new Date().toISOString();
    db.run(
        `INSERT INTO "download_collection"
         ("id", "share_id", "source_url", "password_plain", "name", "root_id", "segment_size",
          "expires", "tree_json", "save_path", "status", "created_at", "updated_at", "elapsed_ms",
          "error", "ascii_filenames", "provider")
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?)`,
        [
            "collection",
            "share",
            "https://transfer.it/example",
            "Example",
            "root",
            TRANSFER_CHUNK_SIZE,
            0,
            "{}",
            "/tmp",
            "downloading",
            now,
            now,
            "transfer",
        ],
    );
    db.run(
        `INSERT INTO "download_file"
         ("id", "collection_id", "remote_id", "path", "name", "size", "selected", "status",
          "downloaded_bytes", "paused_by_user", "created_at", "updated_at", "error",
          "source_kind", "zip_entry_json", "source_meta_json")
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, NULL, 'file', NULL, ?)`,
        [
            "file",
            "collection",
            "remote",
            "file.bin",
            "file.bin",
            options.fileSize,
            "downloading",
            options.fileDownloadedBytes ?? 0,
            now,
            now,
            JSON.stringify({ k: "key" }),
        ],
    );
    for (const chunk of options.chunks) {
        db.run(
            `INSERT INTO "download_chunk"
             ("collection_id", "file_id", "chunk_index", "offset", "size", "status",
              "downloaded_bytes", "attempts", "updated_at", "error")
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
            [
                "collection",
                "file",
                chunk.chunkIndex,
                chunk.offset,
                chunk.size,
                chunk.status,
                chunk.downloadedBytes,
                now,
            ],
        );
    }
}

describe("DownloadRepository.reconcileTransferChunkLayout", () => {
    it("keeps matching Transfer chunk progress", async () => {
        const { db, repo } = await createRepository();
        const fileSize = TRANSFER_CHUNK_SIZE + 10;
        const expected = transferChunkSizes(fileSize);
        seedTransferFile(db, {
            fileSize,
            fileDownloadedBytes: expected[0]!.size,
            chunks: [
                {
                    chunkIndex: 0,
                    offset: expected[0]!.start,
                    size: expected[0]!.size,
                    status: "completed",
                    downloadedBytes: expected[0]!.size,
                },
                {
                    chunkIndex: 1,
                    offset: expected[1]!.start,
                    size: expected[1]!.size,
                    status: "pending",
                    downloadedBytes: 123,
                },
            ],
        });

        expect(repo.reconcileTransferChunkLayout("file")).toBe(false);
        expect(repo.listChunks("file")).toMatchObject([
            {
                chunkIndex: 0,
                offset: expected[0]!.start,
                size: expected[0]!.size,
                status: "completed",
                downloadedBytes: expected[0]!.size,
            },
            {
                chunkIndex: 1,
                offset: expected[1]!.start,
                size: expected[1]!.size,
                status: "pending",
                downloadedBytes: 123,
            },
        ]);
        expect(repo.getFile("file")?.downloadedBytes).toBe(expected[0]!.size);
    });

    it("wipes MEGA-layout chunks and resets downloaded bytes", async () => {
        const { db, repo } = await createRepository();
        const fileSize = TRANSFER_CHUNK_SIZE + 10;
        seedTransferFile(db, {
            fileSize,
            fileDownloadedBytes: 131_072,
            chunks: [
                {
                    chunkIndex: 0,
                    offset: 0,
                    size: 131_072,
                    status: "completed",
                    downloadedBytes: 131_072,
                },
                {
                    chunkIndex: 1,
                    offset: 131_072,
                    size: 262_144,
                    status: "pending",
                    downloadedBytes: 40_000,
                },
            ],
        });

        expect(repo.reconcileTransferChunkLayout("file")).toBe(true);
        expect(db.all(`SELECT * FROM "download_chunk" WHERE "file_id" = ?`, ["file"])).toEqual([]);
        expect(repo.getFile("file")?.downloadedBytes).toBe(0);
        expect(repo.listChunks("file")).toMatchObject(
            transferChunkSizes(fileSize).map((chunk, chunkIndex) => ({
                chunkIndex,
                offset: chunk.start,
                size: chunk.size,
                status: "pending",
                downloadedBytes: 0,
            })),
        );
    });
});
