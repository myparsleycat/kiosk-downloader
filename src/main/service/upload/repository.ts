import { randomUUID } from "node:crypto";

import type { UploadItem, UploadStatus, FileUploadStatus } from "@shared/types";

import type { KioskDownloader } from "../..";
import type {
    CreateUploadRecord,
    UploadChunkRow,
    UploadCollectionRow,
    UploadFileRow,
} from "./types";

function nowIso() {
    return new Date().toISOString();
}

export class UploadRepository {
    public constructor(private readonly kd: KioskDownloader) {}

    public restoreStartupState(mode: "auto" | "manual") {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(`DELETE FROM "upload_chunk" WHERE "status" = 'uploading'`);
            tx.run(
                `UPDATE "upload_file"
                 SET "status" = 'pending', "updated_at" = ?, "error" = NULL
                 WHERE "status" = 'uploading' AND "paused_by_user" = 0`,
                [timestamp],
            );
            tx.run(
                `UPDATE "upload_collection"
                 SET "status" = 'queued', "updated_at" = ?, "error" = NULL
                 WHERE "status" = 'uploading'`,
                [timestamp],
            );

            if (mode === "manual") {
                tx.run(
                    `UPDATE "upload_collection"
                     SET "status" = 'queued', "updated_at" = ?
                     WHERE "status" = 'uploading'`,
                    [timestamp],
                );
            }
        });
    }

    public insertUpload(record: CreateUploadRecord): string {
        const collectionId = randomUUID();
        const timestamp = nowIso();
        const fileRows = record.files.map((file) => ({
            ...file,
            id: randomUUID(),
            remoteId: "",
        }));

        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `INSERT INTO "upload_collection"
                 ("id", "name", "description", "password_plain", "share_id", "share_link",
                  "collection_uuid", "upload_token", "tree_json", "eternal", "expires", "status",
                  "created_at", "updated_at", "elapsed_ms", "error")
                 VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, NULL)`,
                [
                    collectionId,
                    record.options.name.slice(0, 100),
                    record.options.description.slice(0, 2500),
                    record.options.password || null,
                    record.created.collectionUuid.toString("hex"),
                    record.created.uploadToken,
                    JSON.stringify(record.tree),
                    record.options.eternal ? 1 : 0,
                    record.options.expires,
                    timestamp,
                    timestamp,
                ],
            );

            for (const file of fileRows) {
                tx.run(
                    `INSERT INTO "upload_file"
                     ("id", "collection_id", "remote_id", "path", "name", "size", "fs_path",
                      "status", "uploaded_bytes", "paused_by_user", "created_at", "updated_at", "error")
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, NULL)`,
                    [
                        file.id,
                        collectionId,
                        file.remoteId,
                        file.path,
                        file.name,
                        file.size,
                        file.fsPath,
                        timestamp,
                        timestamp,
                    ],
                );
            }
        });

        return collectionId;
    }

    public listItems(): UploadItem[] {
        const collections = this.kd.lib.db.all<UploadCollectionRow>(
            collectionSelectSql() + ` ORDER BY "created_at" DESC`,
        );
        return collections.map((collection) => this.buildItem(collection));
    }

    public getItem(collectionId: string): UploadItem | null {
        const collection = this.getCollection(collectionId);
        return collection ? this.buildItem(collection) : null;
    }

    public getCollection(collectionId: string): UploadCollectionRow | null {
        return this.kd.lib.db.get<UploadCollectionRow>(
            collectionSelectSql() + ` WHERE "id" = ? LIMIT 1`,
            [collectionId],
        );
    }

    public listRunnableCollections(): UploadCollectionRow[] {
        return this.kd.lib.db.all<UploadCollectionRow>(
            collectionSelectSql() +
                ` WHERE "status" IN ('queued', 'uploading') ORDER BY "created_at" ASC`,
        );
    }

    public listFiles(collectionId: string): UploadFileRow[] {
        return this.kd.lib.db.all<UploadFileRow>(
            fileSelectSql() + ` WHERE "collection_id" = ? ORDER BY "path" ASC`,
            [collectionId],
        );
    }

    public listPendingFiles(collectionId: string): UploadFileRow[] {
        return this.kd.lib.db.all<UploadFileRow>(
            fileSelectSql() +
                ` WHERE "collection_id" = ? AND "status" = 'pending' ORDER BY "created_at" ASC, "path" ASC`,
            [collectionId],
        );
    }

    public getFile(fileId: string): UploadFileRow | null {
        return this.kd.lib.db.get<UploadFileRow>(fileSelectSql() + ` WHERE "id" = ? LIMIT 1`, [
            fileId,
        ]);
    }

    public markCollectionStatus(collectionId: string, status: UploadStatus, error?: string | null) {
        this.kd.lib.db.run(
            `UPDATE "upload_collection"
             SET "status" = ?, "updated_at" = ?, "error" = ?
             WHERE "id" = ?`,
            [status, nowIso(), error ?? null, collectionId],
        );
    }

    public addCollectionElapsedMs(collectionId: string, deltaMs: number) {
        if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
            return;
        }
        this.kd.lib.db.run(
            `UPDATE "upload_collection"
             SET "elapsed_ms" = "elapsed_ms" + ?, "updated_at" = ?
             WHERE "id" = ?`,
            [Math.round(deltaMs), nowIso(), collectionId],
        );
    }

    public getCollectionElapsedMs(collectionId: string): number {
        const row = this.kd.lib.db.get<{ elapsedMs: number }>(
            `SELECT "elapsed_ms" AS "elapsedMs" FROM "upload_collection" WHERE "id" = ? LIMIT 1`,
            [collectionId],
        );
        return row?.elapsedMs ?? 0;
    }

    public markFileStatus(fileId: string, status: FileUploadStatus, error?: string | null) {
        this.kd.lib.db.run(
            `UPDATE "upload_file"
             SET "status" = ?, "updated_at" = ?, "error" = ?
             WHERE "id" = ?`,
            [status, nowIso(), error ?? null, fileId],
        );
    }

    public setFileRemoteId(fileId: string, remoteId: string) {
        this.kd.lib.db.run(
            `UPDATE "upload_file" SET "remote_id" = ?, "updated_at" = ? WHERE "id" = ?`,
            [remoteId, nowIso(), fileId],
        );
    }

    public markChunkUploading(chunk: UploadChunkRow) {
        this.kd.lib.db.run(
            `INSERT INTO "upload_chunk"
             ("collection_id", "file_id", "chunk_index", "offset", "size", "status",
              "uploaded_bytes", "attempts", "updated_at", "error")
             VALUES (?, ?, ?, ?, ?, 'uploading', 0, 1, ?, NULL)
             ON CONFLICT("file_id", "chunk_index") DO UPDATE
             SET "collection_id" = excluded."collection_id",
                 "offset" = excluded."offset",
                 "size" = excluded."size",
                 "status" = 'uploading',
                 "uploaded_bytes" = 0,
                 "attempts" = "upload_chunk"."attempts" + 1,
                 "updated_at" = excluded."updated_at",
                 "error" = NULL`,
            [
                chunk.collectionId,
                chunk.fileId,
                chunk.chunkIndex,
                chunk.offset,
                chunk.size,
                nowIso(),
            ],
        );
    }

    public markChunkCompleted(chunk: UploadChunkRow, bytes: number) {
        this.kd.lib.db.run(
            `INSERT INTO "upload_chunk"
             ("collection_id", "file_id", "chunk_index", "offset", "size", "status",
              "uploaded_bytes", "attempts", "updated_at", "error")
             VALUES (?, ?, ?, ?, ?, 'completed', ?, 0, ?, NULL)
             ON CONFLICT("file_id", "chunk_index") DO UPDATE
             SET "collection_id" = excluded."collection_id",
                 "offset" = excluded."offset",
                 "size" = excluded."size",
                 "status" = 'completed',
                 "uploaded_bytes" = excluded."uploaded_bytes",
                 "updated_at" = excluded."updated_at",
                 "error" = NULL`,
            [
                chunk.collectionId,
                chunk.fileId,
                chunk.chunkIndex,
                chunk.offset,
                chunk.size,
                bytes,
                nowIso(),
            ],
        );
    }

    public markChunkPending(fileId: string, chunkIndex: number) {
        this.kd.lib.db.run(`DELETE FROM "upload_chunk" WHERE "file_id" = ? AND "chunk_index" = ?`, [
            fileId,
            chunkIndex,
        ]);
    }

    public markChunkError(chunk: UploadChunkRow, error: string) {
        this.kd.lib.db.run(
            `INSERT INTO "upload_chunk"
             ("collection_id", "file_id", "chunk_index", "offset", "size", "status",
              "uploaded_bytes", "attempts", "updated_at", "error")
             VALUES (?, ?, ?, ?, ?, 'error', 0, 0, ?, ?)
             ON CONFLICT("file_id", "chunk_index") DO UPDATE
             SET "collection_id" = excluded."collection_id",
                 "offset" = excluded."offset",
                 "size" = excluded."size",
                 "status" = 'error',
                 "uploaded_bytes" = 0,
                 "updated_at" = excluded."updated_at",
                 "error" = excluded."error"`,
            [
                chunk.collectionId,
                chunk.fileId,
                chunk.chunkIndex,
                chunk.offset,
                chunk.size,
                nowIso(),
                error,
            ],
        );
    }

    public resetRunningChunksForFile(fileId: string) {
        this.kd.lib.db.run(
            `DELETE FROM "upload_chunk" WHERE "file_id" = ? AND "status" = 'uploading'`,
            [fileId],
        );
    }

    public hasErroredChunk(fileId: string): boolean {
        const row = this.kd.lib.db.get<{ count: number }>(
            `SELECT COUNT(*) AS "count" FROM "upload_chunk" WHERE "file_id" = ? AND "status" = 'error'`,
            [fileId],
        );
        return Number(row?.count ?? 0) > 0;
    }

    public pauseCollection(collectionId: string) {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `UPDATE "upload_collection"
                 SET "status" = 'paused', "updated_at" = ?, "error" = NULL
                 WHERE "id" = ?`,
                [timestamp, collectionId],
            );
            tx.run(
                `UPDATE "upload_file"
                 SET "status" = 'paused', "updated_at" = ?, "error" = NULL
                 WHERE "collection_id" = ? AND "status" IN ('pending', 'uploading')`,
                [timestamp, collectionId],
            );
            tx.run(
                `DELETE FROM "upload_chunk" WHERE "collection_id" = ? AND "status" = 'uploading'`,
                [collectionId],
            );
        });
    }

    public resumeCollection(collectionId: string, force: boolean) {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `UPDATE "upload_collection"
                 SET "status" = 'queued', "updated_at" = ?, "error" = NULL
                 WHERE "id" = ?`,
                [timestamp, collectionId],
            );
            tx.run(
                `UPDATE "upload_file"
                 SET "status" = 'pending', "paused_by_user" = 0, "updated_at" = ?, "error" = NULL
                 WHERE "collection_id" = ? AND "status" = 'paused'`,
                [timestamp, collectionId],
            );
            if (force) {
                tx.run(
                    `UPDATE "upload_file"
                     SET "status" = 'pending', "paused_by_user" = 0, "updated_at" = ?, "error" = NULL
                     WHERE "collection_id" = ? AND "status" = 'error'`,
                    [timestamp, collectionId],
                );
                tx.run(
                    `DELETE FROM "upload_chunk" WHERE "collection_id" = ? AND "status" = 'error'`,
                    [collectionId],
                );
            }
        });
    }

    public pauseFile(fileId: string) {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `UPDATE "upload_file"
                 SET "status" = 'paused', "paused_by_user" = 1, "updated_at" = ?, "error" = NULL
                 WHERE "id" = ? AND "status" != 'completed'`,
                [timestamp, fileId],
            );
            tx.run(`DELETE FROM "upload_chunk" WHERE "file_id" = ? AND "status" = 'uploading'`, [
                fileId,
            ]);
        });
    }

    public resumeFile(fileId: string, force: boolean) {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `UPDATE "upload_file"
                 SET "status" = 'pending', "paused_by_user" = 0, "updated_at" = ?, "error" = NULL
                 WHERE "id" = ? AND "status" IN ('paused', 'pending', 'error')`,
                [timestamp, fileId],
            );
            if (force) {
                tx.run(`DELETE FROM "upload_chunk" WHERE "file_id" = ? AND "status" = 'error'`, [
                    fileId,
                ]);
            }
        });
    }

    public syncFileUploadedBytes(fileId: string) {
        const row = this.kd.lib.db.get<{ uploaded: number | null }>(
            `SELECT SUM("uploaded_bytes") AS "uploaded"
             FROM "upload_chunk"
             WHERE "file_id" = ? AND "status" = 'completed'`,
            [fileId],
        );
        const file = this.getFile(fileId);
        if (!file) {
            return;
        }
        const uploaded = Math.min(file.size, Math.max(0, Number(row?.uploaded ?? 0)));
        this.kd.lib.db.run(
            `UPDATE "upload_file" SET "uploaded_bytes" = ?, "updated_at" = ? WHERE "id" = ?`,
            [uploaded, nowIso(), fileId],
        );
    }

    public addFileUploadedBytes(fileId: string, bytes: number) {
        this.kd.lib.db.run(
            `UPDATE "upload_file"
             SET "uploaded_bytes" = MIN("size", "uploaded_bytes" + ?), "updated_at" = ?
             WHERE "id" = ?`,
            [bytes, nowIso(), fileId],
        );
    }

    public completeFile(fileId: string) {
        const file = this.getFile(fileId);
        if (!file) {
            return;
        }
        this.kd.lib.db.run(
            `UPDATE "upload_file"
             SET "status" = 'completed', "uploaded_bytes" = "size", "updated_at" = ?, "error" = NULL
             WHERE "id" = ?`,
            [nowIso(), fileId],
        );
    }

    public completeCollection(collectionId: string, shareLink: string) {
        this.kd.lib.db.run(
            `UPDATE "upload_collection"
             SET "status" = 'completed', "share_link" = ?, "updated_at" = ?, "error" = NULL
             WHERE "id" = ?`,
            [shareLink, nowIso(), collectionId],
        );
    }

    public deleteCollection(collectionId: string) {
        this.kd.lib.db.run(`DELETE FROM "upload_collection" WHERE "id" = ?`, [collectionId]);
    }

    public recomputeCollectionStatus(collectionId: string) {
        const collection = this.getCollection(collectionId);
        if (!collection || collection.status === "paused" || collection.status === "completed") {
            return;
        }

        const files = this.listFiles(collectionId);
        if (files.length === 0) {
            this.markCollectionStatus(collectionId, "completed");
            return;
        }
        if (files.every((file) => file.status === "completed")) {
            this.markCollectionStatus(collectionId, "completed");
            return;
        }
        if (files.some((file) => file.status === "uploading")) {
            this.markCollectionStatus(collectionId, "uploading");
            return;
        }
        if (files.every((file) => file.status === "paused" || file.status === "completed")) {
            this.markCollectionStatus(collectionId, "paused");
            return;
        }
        if (files.every((file) => file.status === "completed" || file.status === "error")) {
            this.markCollectionStatus(
                collectionId,
                files.some((file) => file.status === "error") ? "error" : "completed",
            );
            return;
        }

        this.markCollectionStatus(collectionId, "queued");
    }

    private buildItem(collection: UploadCollectionRow): UploadItem {
        const progress: UploadItem["progress"] = {};
        for (const file of this.listFiles(collection.id)) {
            progress[file.path] = {
                fileId: file.id,
                path: file.path,
                status: file.status,
                uploaded: file.uploadedBytes,
                size: file.size,
                error: file.error ?? undefined,
            };
        }

        return {
            id: collection.id,
            name: collection.name,
            description: collection.description,
            passwordProtected: collection.passwordPlain != null,
            expires: collection.expires,
            eternal: collection.eternal === 1,
            shareLink: collection.shareLink,
            progress,
            status: collection.status,
            createdAt: Date.parse(collection.createdAt),
            updatedAt: Date.parse(collection.updatedAt),
            elapsedMs: collection.elapsedMs,
            error: collection.error ?? undefined,
        };
    }
}

function collectionSelectSql() {
    return `SELECT "id",
                   "name",
                   "description",
                   "password_plain" AS "passwordPlain",
                   "share_id" AS "shareId",
                   "share_link" AS "shareLink",
                   "collection_uuid" AS "collectionUuid",
                   "upload_token" AS "uploadToken",
                   "tree_json" AS "treeJson",
                   "eternal",
                   "expires",
                   "status",
                   "created_at" AS "createdAt",
                   "updated_at" AS "updatedAt",
                   "elapsed_ms" AS "elapsedMs",
                   "error"
            FROM "upload_collection"`;
}

function fileSelectSql() {
    return `SELECT "id",
                   "collection_id" AS "collectionId",
                   "remote_id" AS "remoteId",
                   "path",
                   "name",
                   "size",
                   "fs_path" AS "fsPath",
                   "status",
                   "uploaded_bytes" AS "uploadedBytes",
                   "paused_by_user" AS "pausedByUser",
                   "created_at" AS "createdAt",
                   "updated_at" AS "updatedAt",
                   "error"
            FROM "upload_file"`;
}
