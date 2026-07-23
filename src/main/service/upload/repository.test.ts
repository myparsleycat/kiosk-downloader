import { describe, expect, it } from "vitest";

import type { KioskDownloader } from "../..";
import type { CreateUploadRecord } from "./types";

import { DatabaseClient } from "../../lib/db/client";
import { UploadRepository } from "./repository";

describe("UploadRepository.restoreStartupState", () => {
    it("recovers interrupted work while preserving user-paused files", async () => {
        const db = new DatabaseClient(":memory:");
        await db.reconcile();
        const repo = new UploadRepository({ lib: { db } } as KioskDownloader);
        const timestamp = new Date().toISOString();
        db.run(
            `INSERT INTO "upload_collection"
             ("id", "name", "collection_uuid", "upload_token", "tree_json", "expires", "status",
              "created_at", "updated_at", "error")
             VALUES ('collection', 'Collection', 'uuid', 'token', ?, ?, 'uploading', ?, ?, ?)`,
            [
                JSON.stringify({ type: "dir", id: "root", name: "", entries: [] }),
                Date.now() + 60_000,
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
                `INSERT INTO "upload_file"
                 ("id", "collection_id", "remote_id", "path", "name", "size", "fs_path",
                  "source_mtime_ms", "status", "paused_by_user", "created_at", "updated_at", "error")
                 VALUES (?, 'collection', ?, ?, ?, 10, ?, 0, 'uploading', ?, ?, ?, ?)`,
                [
                    id,
                    id,
                    `${id}.bin`,
                    `${id}.bin`,
                    `/tmp/${id}.bin`,
                    pausedByUser ? 1 : 0,
                    timestamp,
                    timestamp,
                    "error",
                ],
            );
        }
        db.run(
            `INSERT INTO "upload_chunk"
             ("collection_id", "file_id", "chunk_index", "offset", "size", "status",
              "updated_at", "error")
             VALUES ('collection', 'active', 0, 0, 10, 'uploading', ?, ?)`,
            [timestamp, "error"],
        );

        repo.restoreStartupState();

        expect(
            db.get<{ status: string; error: string | null }>(
                `SELECT "status", "error" FROM "upload_collection" WHERE "id" = 'collection'`,
            ),
        ).toEqual({ status: "queued", error: null });
        expect(
            db.all<{ id: string; status: string; error: string | null }>(
                `SELECT "id", "status", "error" FROM "upload_file" ORDER BY "id"`,
            ),
        ).toEqual([
            { id: "active", status: "pending", error: null },
            { id: "paused", status: "uploading", error: "error" },
        ]);
        expect(db.get<{ count: number }>(`SELECT COUNT(*) AS "count" FROM "upload_chunk"`)).toEqual(
            { count: 0 },
        );
    });
});

describe("UploadRepository bundles", () => {
    it("aggregates physical pieces as one logical file", async () => {
        const db = new DatabaseClient(":memory:");
        await db.reconcile();
        const repo = new UploadRepository({ lib: { db } } as KioskDownloader);
        const tree = {
            type: "dir" as const,
            id: "root",
            name: "",
            entries: [
                {
                    kind: "file" as const,
                    node: { type: "file" as const, id: "large.bin", name: "large.bin", size: 15 },
                },
            ],
        };
        repo.insertBundle({
            id: "bundle",
            mode: "integrated",
            name: "Bundle",
            description: "",
            password: "",
            treeJson: JSON.stringify(tree),
            planJson: JSON.stringify({ collections: [] }),
            physicalCount: 2,
            expires: Date.now() + 60_000,
        });
        for (const [ordinal, size, offset] of [
            [0, 10, 0],
            [1, 5, 10],
        ] as const) {
            repo.insertUpload({
                created: {
                    collectionUuid: Buffer.alloc(16, ordinal + 1),
                    uploadToken: `token-${ordinal}`,
                    root: { id: Buffer.alloc(16), name: "", files: [], children: [] },
                },
                options: {
                    name: `Bundle (${ordinal + 1}/2)`,
                    description: "",
                    password: "",
                    expires: Date.now() + 60_000,
                },
                files: [
                    {
                        path: `.parts/${ordinal}`,
                        name: String(ordinal),
                        size,
                        fsPath: "/tmp/large.bin",
                        sourceMtimeMs: 0,
                        logicalPath: "large.bin",
                        logicalSize: 15,
                        sourceOffset: offset,
                        logicalSha256: "00".repeat(32),
                    },
                ],
                segmentSize: 16,
                tree,
                bundleId: "bundle",
                ordinal,
            });
        }

        expect(repo.getItem("bundle")).toMatchObject({
            id: "bundle",
            summary: { totalBytes: 15, totalFiles: 1 },
            progress: { "large.bin": { size: 15, uploaded: 0 } },
            physicalCollectionCount: 2,
        });

        const firstCollection = repo.listBundleCollections("bundle")[0];
        repo.markCollectionStatus(firstCollection.id, "completed");
        db.run(`UPDATE "upload_file" SET "uploaded_bytes" = "size" WHERE "collection_id" = ?`, [
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

    it("projects one physical pack as multiple logical file progress rows", async () => {
        const db = new DatabaseClient(":memory:");
        await db.reconcile();
        const repo = new UploadRepository({ lib: { db } } as KioskDownloader);
        const tree = {
            type: "dir" as const,
            id: "root",
            name: "",
            entries: [],
        };
        repo.insertBundle({
            id: "packed-bundle",
            mode: "integrated",
            name: "Packed",
            description: "",
            password: "",
            treeJson: JSON.stringify(tree),
            planJson: JSON.stringify({
                collections: [
                    {
                        files: [
                            {
                                path: "packs/0",
                                packEntries: [
                                    { path: "a.txt", size: 4 },
                                    { path: "b.txt", size: 6 },
                                ],
                            },
                        ],
                    },
                ],
            }),
            physicalCount: 1,
            expires: Date.now() + 60_000,
        });
        repo.insertUpload({
            created: {
                collectionUuid: Buffer.alloc(16, 1),
                uploadToken: "token",
                root: { id: Buffer.alloc(16), name: "", files: [], children: [] },
            },
            options: {
                name: "Packed (1/1)",
                description: "",
                password: "",
                expires: Date.now() + 60_000,
            },
            files: [
                {
                    path: "packs/0",
                    name: "0",
                    size: 10,
                    fsPath: "/tmp/pack",
                    sourceMtimeMs: 0,
                },
            ],
            segmentSize: 16,
            tree,
            bundleId: "packed-bundle",
            ordinal: 0,
        });

        expect(repo.getItem("packed-bundle")).toMatchObject({
            summary: { totalBytes: 10, totalFiles: 2 },
            progress: {
                "a.txt": { size: 4, uploaded: 0 },
                "b.txt": { size: 6, uploaded: 0 },
            },
        });
    });

    it("returns dirty-only bundle progress without full map", async () => {
        const db = new DatabaseClient(":memory:");
        await db.reconcile();
        const repo = new UploadRepository({ lib: { db } } as KioskDownloader);
        const tree = {
            type: "dir" as const,
            id: "root",
            name: "",
            entries: [],
        };
        repo.insertBundle({
            id: "bundle",
            mode: "integrated",
            name: "Bundle",
            description: "",
            password: "",
            treeJson: JSON.stringify(tree),
            planJson: JSON.stringify({ collections: [] }),
            physicalCount: 2,
            expires: Date.now() + 60_000,
        });
        for (const [ordinal, size, offset] of [
            [0, 10, 0],
            [1, 5, 10],
        ] as const) {
            repo.insertUpload({
                created: {
                    collectionUuid: Buffer.alloc(16, ordinal + 1),
                    uploadToken: `token-${ordinal}`,
                    root: { id: Buffer.alloc(16), name: "", files: [], children: [] },
                },
                options: {
                    name: `Bundle (${ordinal + 1}/2)`,
                    description: "",
                    password: "",
                    expires: Date.now() + 60_000,
                },
                files: [
                    {
                        path: `.parts/${ordinal}`,
                        name: String(ordinal),
                        size,
                        fsPath: "/tmp/large.bin",
                        sourceMtimeMs: 0,
                        logicalPath: "large.bin",
                        logicalSize: 15,
                        sourceOffset: offset,
                        logicalSha256: "00".repeat(32),
                    },
                ],
                segmentSize: 16,
                tree,
                bundleId: "bundle",
                ordinal,
            });
        }

        const firstFile = repo.listBundleFiles("bundle")[0];
        db.run(
            `UPDATE "upload_file" SET "uploaded_bytes" = 10, "status" = 'uploading' WHERE "id" = ?`,
            [firstFile.id],
        );

        const snapshot = repo.getBundleProgressSnapshot("bundle", new Set([firstFile.id]));
        expect(snapshot).toMatchObject({
            summary: { totalBytes: 15, totalFiles: 1, transferredBytes: 10 },
            progress: {
                "large.bin": { size: 15, uploaded: 10, status: "uploading" },
            },
        });
        expect(Object.keys(snapshot!.progress)).toEqual(["large.bin"]);
    });

    it("returns pack logical keys for a dirty packed physical file", async () => {
        const db = new DatabaseClient(":memory:");
        await db.reconcile();
        const repo = new UploadRepository({ lib: { db } } as KioskDownloader);
        const tree = {
            type: "dir" as const,
            id: "root",
            name: "",
            entries: [],
        };
        repo.insertBundle({
            id: "packed-bundle",
            mode: "integrated",
            name: "Packed",
            description: "",
            password: "",
            treeJson: JSON.stringify(tree),
            planJson: JSON.stringify({
                collections: [
                    {
                        files: [
                            {
                                path: "packs/0",
                                packEntries: [
                                    { path: "a.txt", size: 4 },
                                    { path: "b.txt", size: 6 },
                                ],
                            },
                        ],
                    },
                ],
            }),
            physicalCount: 1,
            expires: Date.now() + 60_000,
        });
        repo.insertUpload({
            created: {
                collectionUuid: Buffer.alloc(16, 1),
                uploadToken: "token",
                root: { id: Buffer.alloc(16), name: "", files: [], children: [] },
            },
            options: {
                name: "Packed (1/1)",
                description: "",
                password: "",
                expires: Date.now() + 60_000,
            },
            files: [
                {
                    path: "packs/0",
                    name: "0",
                    size: 10,
                    fsPath: "/tmp/pack",
                    sourceMtimeMs: 0,
                },
            ],
            segmentSize: 16,
            tree,
            bundleId: "packed-bundle",
            ordinal: 0,
        });

        const packFile = repo.listBundleFiles("packed-bundle")[0];
        db.run(
            `UPDATE "upload_file" SET "uploaded_bytes" = 5, "status" = 'uploading' WHERE "id" = ?`,
            [packFile.id],
        );

        const snapshot = repo.getBundleProgressSnapshot("packed-bundle", new Set([packFile.id]));
        expect(snapshot).toMatchObject({
            summary: { totalBytes: 10, totalFiles: 2, transferredBytes: 5 },
            progress: {
                "a.txt": { size: 4, uploaded: 2 },
                "b.txt": { size: 6, uploaded: 3 },
            },
        });
        expect(Object.keys(snapshot!.progress).sort()).toEqual(["a.txt", "b.txt"]);
    });
});

describe("UploadRepository bundle-ordinal uniqueness", () => {
    const baseUpload: CreateUploadRecord = {
        created: {
            collectionUuid: Buffer.alloc(16, 1),
            uploadToken: "token",
            root: { id: Buffer.alloc(16), name: "", files: [], children: [] },
        },
        options: {
            name: "Bundle (1/1)",
            description: "",
            password: "",
            expires: Date.now() + 60_000,
        },
        files: [],
        segmentSize: 16,
        tree: { type: "dir", id: "root", name: "", entries: [] },
    };

    it("rejects a second active collection with the same (bundle_id, ordinal)", async () => {
        const db = new DatabaseClient(":memory:");
        await db.reconcile();
        const repo = new UploadRepository({ lib: { db } } as KioskDownloader);
        repo.insertBundle({
            id: "bundle",
            mode: "integrated",
            name: "Bundle",
            description: "",
            password: "",
            treeJson: JSON.stringify(baseUpload.tree),
            planJson: JSON.stringify({ collections: [] }),
            physicalCount: 1,
            expires: Date.now() + 60_000,
        });

        repo.insertUpload({ ...baseUpload, bundleId: "bundle", ordinal: 0 });
        expect(() =>
            repo.insertUpload({ ...baseUpload, bundleId: "bundle", ordinal: 0 }),
        ).toThrow();
    });

    it("allows a new active collection once the previous one is superseded", async () => {
        const db = new DatabaseClient(":memory:");
        await db.reconcile();
        const repo = new UploadRepository({ lib: { db } } as KioskDownloader);
        repo.insertBundle({
            id: "bundle",
            mode: "integrated",
            name: "Bundle",
            description: "",
            password: "",
            treeJson: JSON.stringify(baseUpload.tree),
            planJson: JSON.stringify({ collections: [] }),
            physicalCount: 1,
            expires: Date.now() + 60_000,
        });

        const firstId = repo.insertUpload({ ...baseUpload, bundleId: "bundle", ordinal: 0 });
        repo.supersedeCollection(firstId);
        // Superseded row drops out of the partial index, so the replacement inserts cleanly.
        repo.insertUpload({ ...baseUpload, bundleId: "bundle", ordinal: 0 });
        expect(repo.listBundleCollections("bundle")).toHaveLength(1);
        expect(repo.hasBundleCollectionOrdinal("bundle", 0)).toBe(true);
    });
});
