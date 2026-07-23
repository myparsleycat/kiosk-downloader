import type { DirNode, DownloadTransferPayload } from "@shared/types";
import { DOWNLOAD_TRANSFER_KIND, DOWNLOAD_TRANSFER_VERSION } from "@shared/types";
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

describe("DownloadRepository.restoreStartupState", () => {
    it("recovers interrupted work while preserving user-paused files", async () => {
        const { db, repo } = await createRepository();
        const timestamp = new Date().toISOString();
        db.run(
            `INSERT INTO "download_collection"
             ("id", "share_id", "source_url", "name", "root_id", "segment_size", "expires",
              "tree_json", "save_path", "status", "created_at", "updated_at", "error")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'downloading', ?, ?, ?)`,
            [
                "collection",
                "share",
                "https://example.com/share",
                "Collection",
                "root",
                1024,
                Date.now() + 60_000,
                JSON.stringify({ type: "dir", id: "root", name: "", entries: [] }),
                "/tmp",
                timestamp,
                timestamp,
                "interrupted",
            ],
        );
        for (const [id, pausedByUser] of [
            ["active", false],
            ["paused", true],
        ] as const) {
            db.run(
                `INSERT INTO "download_file"
                 ("id", "collection_id", "remote_id", "path", "name", "size", "selected",
                  "status", "paused_by_user", "created_at", "updated_at", "error")
                 VALUES (?, 'collection', ?, ?, ?, 10, 1, 'downloading', ?, ?, ?, ?)`,
                [
                    id,
                    id,
                    `${id}.bin`,
                    `${id}.bin`,
                    pausedByUser ? 1 : 0,
                    timestamp,
                    timestamp,
                    "error",
                ],
            );
        }
        db.run(
            `INSERT INTO "download_chunk"
             ("collection_id", "file_id", "chunk_index", "offset", "size", "status",
              "updated_at", "error")
             VALUES ('collection', 'active', 0, 0, 10, 'downloading', ?, ?)`,
            [timestamp, "error"],
        );

        repo.restoreStartupState();

        expect(
            db.get<{ status: string; error: string | null }>(
                `SELECT "status", "error" FROM "download_collection" WHERE "id" = 'collection'`,
            ),
        ).toEqual({ status: "queued", error: null });
        expect(
            db.all<{ id: string; status: string; error: string | null }>(
                `SELECT "id", "status", "error" FROM "download_file" ORDER BY "id"`,
            ),
        ).toEqual([
            { id: "active", status: "pending", error: null },
            { id: "paused", status: "downloading", error: "error" },
        ]);
        expect(
            db.get<{ status: string; error: string | null }>(
                `SELECT "status", "error" FROM "download_chunk" WHERE "file_id" = 'active'`,
            ),
        ).toEqual({ status: "pending", error: null });
    });
});

describe("DownloadRepository bundles", () => {
    it("aggregates downloaded pieces as one logical file", async () => {
        const { db, repo } = await createRepository();
        const tree: DirNode = {
            type: "dir",
            id: "root",
            name: "",
            entries: [
                {
                    kind: "file",
                    node: { type: "file", id: "large.bin", name: "large.bin", size: 15 },
                },
            ],
        };
        repo.insertBundle({
            id: "bundle",
            sourceInput: "KDE1.test",
            name: "Bundle",
            treeJson: JSON.stringify(tree),
            manifestJson: JSON.stringify({
                renames: {},
                splitFiles: [
                    {
                        path: "large.bin",
                        size: 15,
                        sha256: "00".repeat(32),
                        pieces: [
                            { sourceIndex: 0, remoteFileId: "remote-0", offset: 0, length: 10 },
                            { sourceIndex: 1, remoteFileId: "remote-1", offset: 10, length: 5 },
                        ],
                    },
                ],
            }),
            savePath: "/tmp",
            expires: Math.floor(Date.now() / 1000) + 60,
        });
        for (const [ordinal, size] of [
            [0, 10],
            [1, 5],
        ] as const) {
            repo.insertDownload({
                loaded: {
                    provider: "kiosk",
                    cat: "cat",
                    rootId: "root",
                    passwordProtected: false,
                    collection: {
                        shareId: `share-${ordinal}`,
                        name: "Bundle",
                        expires: Math.floor(Date.now() / 1000) + 60,
                        segmentSize: 16,
                        passwordProtected: false,
                        provider: "kiosk",
                        tree: {
                            type: "dir",
                            id: "root",
                            name: "",
                            entries: [
                                {
                                    kind: "file",
                                    node: {
                                        type: "file",
                                        id: `remote-${ordinal}`,
                                        name: `${ordinal}.part`,
                                        size,
                                    },
                                },
                            ],
                        },
                    },
                },
                url: `https://kio.ac/c/share-${ordinal}`,
                savePath: `/tmp/${ordinal}`,
                selectedPaths: [`${ordinal}.part`],
                asciiFilenames: false,
                bundleId: "bundle",
                ordinal,
            });
        }

        expect(repo.getItem("bundle")).toMatchObject({
            id: "bundle",
            collection: { provider: "extended" },
            summary: { totalBytes: 15, totalFiles: 1 },
            progress: { "large.bin": { size: 15, downloaded: 0 } },
        });

        const firstCollection = repo.listBundleCollections("bundle")[0];
        repo.markCollectionStatus(firstCollection.id, "completed");
        db.run(`UPDATE "download_file" SET "downloaded_bytes" = "size" WHERE "collection_id" = ?`, [
            firstCollection.id,
        ]);
        expect(repo.listOsProgressRows()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    status: "completed",
                    transferredBytes: 10,
                    totalBytes: 10,
                }),
                expect.objectContaining({ status: "queued", transferredBytes: 0, totalBytes: 5 }),
            ]),
        );
    });

    it("projects only selected logical ranges from a shared physical pack", async () => {
        const { repo } = await createRepository();
        const tree: DirNode = { type: "dir", id: "root", name: "", entries: [] };
        repo.insertBundle({
            id: "packed-bundle",
            sourceInput: "KDE1.test",
            name: "Packed",
            treeJson: JSON.stringify(tree),
            manifestJson: JSON.stringify({
                renames: {},
                selectedPaths: ["b.txt"],
                splitFiles: [
                    {
                        path: "a.txt",
                        size: 4,
                        pieces: [{ sourceIndex: 0, remoteFileId: "pack", offset: 0, length: 4 }],
                    },
                    {
                        path: "b.txt",
                        size: 6,
                        pieces: [
                            {
                                sourceIndex: 0,
                                remoteFileId: "pack",
                                offset: 0,
                                length: 6,
                                remoteOffset: 4,
                            },
                        ],
                    },
                ],
            }),
            savePath: "/tmp",
            expires: Math.floor(Date.now() / 1000) + 60,
        });
        repo.insertDownload({
            loaded: {
                provider: "kiosk",
                cat: "cat",
                rootId: "root",
                passwordProtected: false,
                collection: {
                    shareId: "share",
                    name: "Packed",
                    expires: Math.floor(Date.now() / 1000) + 60,
                    segmentSize: 16,
                    passwordProtected: false,
                    provider: "kiosk",
                    tree: {
                        type: "dir",
                        id: "root",
                        name: "",
                        entries: [
                            {
                                kind: "file",
                                node: { type: "file", id: "pack", name: "pack", size: 10 },
                            },
                        ],
                    },
                },
            },
            url: "https://kio.ac/c/share",
            savePath: "/tmp/pack",
            selectedPaths: ["pack"],
            asciiFilenames: false,
            bundleId: "packed-bundle",
            ordinal: 0,
        });

        expect(repo.getItem("packed-bundle")).toMatchObject({
            summary: { totalBytes: 6, totalFiles: 1 },
            progress: { "b.txt": { size: 6, downloaded: 0 } },
        });
        expect(repo.getItem("packed-bundle")?.progress["a.txt"]).toBeUndefined();
    });

    it("returns dirty-only bundle progress for a split logical file", async () => {
        const { repo, db } = await createRepository();
        const tree: DirNode = { type: "dir", id: "root", name: "", entries: [] };
        repo.insertBundle({
            id: "bundle",
            sourceInput: "KDE1.test",
            name: "Bundle",
            treeJson: JSON.stringify(tree),
            manifestJson: JSON.stringify({
                renames: {},
                splitFiles: [
                    {
                        path: "large.bin",
                        size: 15,
                        pieces: [
                            {
                                sourceIndex: 0,
                                remoteFileId: "remote-0",
                                offset: 0,
                                length: 10,
                            },
                            {
                                sourceIndex: 1,
                                remoteFileId: "remote-1",
                                offset: 0,
                                length: 5,
                            },
                        ],
                    },
                ],
            }),
            savePath: "/tmp",
            expires: Math.floor(Date.now() / 1000) + 60,
        });
        for (const [ordinal, size] of [
            [0, 10],
            [1, 5],
        ] as const) {
            repo.insertDownload({
                loaded: {
                    provider: "kiosk",
                    cat: "cat",
                    rootId: "root",
                    passwordProtected: false,
                    collection: {
                        shareId: `share-${ordinal}`,
                        name: `Bundle (${ordinal + 1}/2)`,
                        expires: Math.floor(Date.now() / 1000) + 60,
                        segmentSize: 16,
                        passwordProtected: false,
                        provider: "kiosk",
                        tree: {
                            type: "dir",
                            id: "root",
                            name: "",
                            entries: [
                                {
                                    kind: "file",
                                    node: {
                                        type: "file",
                                        id: `remote-${ordinal}`,
                                        name: `${ordinal}.part`,
                                        size,
                                    },
                                },
                            ],
                        },
                    },
                },
                url: `https://kio.ac/c/share-${ordinal}`,
                savePath: `/tmp/${ordinal}`,
                selectedPaths: [`${ordinal}.part`],
                asciiFilenames: false,
                bundleId: "bundle",
                ordinal,
            });
        }

        const firstFile = repo.listBundleFiles("bundle")[0];
        db.run(
            `UPDATE "download_file" SET "downloaded_bytes" = 10, "status" = 'downloading' WHERE "id" = ?`,
            [firstFile.id],
        );

        const snapshot = repo.getBundleProgressSnapshot("bundle", new Set([firstFile.id]));
        expect(snapshot).toMatchObject({
            summary: { totalBytes: 15, totalFiles: 1, transferredBytes: 10 },
            progress: {
                "large.bin": { size: 15, downloaded: 10, status: "downloading" },
            },
        });
        expect(Object.keys(snapshot!.progress)).toEqual(["large.bin"]);
    });
});

function createImportPayload(options: {
    expires: number;
    status: "completed" | "pending";
}): DownloadTransferPayload {
    return {
        version: DOWNLOAD_TRANSFER_VERSION,
        kind: DOWNLOAD_TRANSFER_KIND,
        exportedAt: Date.now(),
        collection: {
            shareId: "imported-share",
            sourceUrl: "https://example.com/imported-share",
            passwordPlain: null,
            name: "Imported",
            rootId: "root",
            segmentSize: 1024,
            expires: options.expires,
            tree: {
                type: "dir",
                id: "root",
                name: "",
                entries: [
                    {
                        kind: "file",
                        node: {
                            type: "file",
                            id: "file",
                            name: "file.bin",
                            size: 12,
                        },
                    },
                ],
            },
            asciiFilenames: false,
            provider: "kiosk",
        },
        files: [
            {
                remoteId: "file",
                path: "file.bin",
                name: "file.bin",
                size: 12,
                selected: true,
                status: options.status,
                completedElsewhere: options.status === "completed",
                sourceKind: "file",
                zipEntryJson: null,
                sourceMetaJson: null,
            },
        ],
    };
}

describe("DownloadRepository.insertImportedDownload", () => {
    it("keeps a fully completed expired import completed without an error", async () => {
        const { repo } = await createRepository();

        const id = repo.insertImportedDownload(
            createImportPayload({ expires: 0, status: "completed" }),
            "/tmp",
        );

        expect(repo.getCollection(id)).toMatchObject({ status: "completed", error: null });
        expect(repo.listFiles(id)).toMatchObject([
            { status: "completed", downloadedBytes: 12, completedElsewhere: 1 },
        ]);
    });

    it("marks an expired import with pending selected files expired", async () => {
        const { repo } = await createRepository();

        const id = repo.insertImportedDownload(
            createImportPayload({ expires: 0, status: "pending" }),
            "/tmp",
        );

        expect(repo.getCollection(id)).toMatchObject({
            status: "expired",
            error: "Collection has expired.",
        });
    });

    it("queues a non-expired import with pending selected files", async () => {
        const { repo } = await createRepository();

        const id = repo.insertImportedDownload(
            createImportPayload({
                expires: Math.ceil(Date.now() / 1000) + 3600,
                status: "pending",
            }),
            "/tmp",
        );

        expect(repo.getCollection(id)).toMatchObject({ status: "queued", error: null });
    });
});

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
