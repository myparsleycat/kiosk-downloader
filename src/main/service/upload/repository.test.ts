import { describe, expect, it } from "vitest";

import type { KioskDownloader } from "../..";

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
