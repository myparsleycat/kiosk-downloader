import { randomUUID } from "node:crypto";

import type {
    DirNode,
    TransferProgressSummary,
    UploadItem,
    UploadStatus,
    FileUploadStatus,
} from "@shared/types";

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

function parseTree(value: string): DirNode {
    return JSON.parse(value) as DirNode;
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
                  "collection_uuid", "upload_token", "tree_json", "expires", "status",
                  "segment_size",
                  "created_at", "updated_at", "elapsed_ms", "error")
                 VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, NULL)`,
                [
                    collectionId,
                    record.options.name.slice(0, 100),
                    record.options.description.slice(0, 2500),
                    record.options.password || null,
                    record.created.collectionUuid.toString("hex"),
                    record.created.uploadToken,
                    JSON.stringify(record.tree),
                    record.options.expires,
                    record.segmentSize,
                    timestamp,
                    timestamp,
                ],
            );

            for (const file of fileRows) {
                tx.run(
                    `INSERT INTO "upload_file"
                     ("id", "collection_id", "remote_id", "path", "name", "size", "fs_path", "source_mtime_ms",
                      "status", "uploaded_bytes", "paused_by_user", "created_at", "updated_at", "error")
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, NULL)`,
                    [
                        file.id,
                        collectionId,
                        file.remoteId,
                        file.path,
                        file.name,
                        file.size,
                        file.fsPath,
                        file.sourceMtimeMs,
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

    public listFilesByIds(collectionId: string, fileIds: Set<string>): UploadFileRow[] {
        if (fileIds.size === 0) {
            return [];
        }
        return this.kd.lib.db.all<UploadFileRow>(
            fileSelectSql() +
                ` WHERE "collection_id" = ? AND "id" IN (${[...fileIds].map(() => "?").join(", ")})`,
            [collectionId, ...fileIds],
        );
    }

    public getProgressSummary(collectionId: string): TransferProgressSummary {
        const row = this.kd.lib.db.get<{
            transferredBytes: number;
            totalBytes: number;
            completedFiles: number;
            totalFiles: number;
        }>(
            `SELECT COALESCE(SUM("uploaded_bytes"), 0) AS "transferredBytes",
                    COALESCE(SUM("size"), 0) AS "totalBytes",
                    COALESCE(SUM(CASE WHEN "status" = 'completed' THEN 1 ELSE 0 END), 0) AS "completedFiles",
                    COUNT(*) AS "totalFiles"
             FROM "upload_file"
             WHERE "collection_id" = ?`,
            [collectionId],
        );
        return row ?? { transferredBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 };
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

    public listCompletedChunkIndexes(fileId: string): number[] {
        return this.kd.lib.db
            .all<{ chunkIndex: number }>(
                `SELECT "chunk_index" AS "chunkIndex"
                 FROM "upload_chunk"
                 WHERE "file_id" = ? AND "status" = 'completed'
                 ORDER BY "chunk_index" ASC`,
                [fileId],
            )
            .map((row) => row.chunkIndex);
    }

    public syncUploadedBytesFromCompletedChunks(fileId: string) {
        this.kd.lib.db.run(
            `UPDATE "upload_file"
             SET "uploaded_bytes" = MIN(
                     "size",
                     COALESCE(
                         (
                             SELECT SUM("size")
                             FROM "upload_chunk"
                             WHERE "file_id" = "upload_file"."id" AND "status" = 'completed'
                         ),
                         0
                     )
                 ),
                 "updated_at" = ?
             WHERE "id" = ? AND "status" != 'completed'`,
            [nowIso(), fileId],
        );
    }

    public syncCollectionUploadedBytesFromCompletedChunks(collectionId: string) {
        this.kd.lib.db.run(
            `UPDATE "upload_file"
             SET "uploaded_bytes" = MIN(
                     "size",
                     COALESCE(
                         (
                             SELECT SUM("size")
                             FROM "upload_chunk"
                             WHERE "file_id" = "upload_file"."id" AND "status" = 'completed'
                         ),
                         0
                     )
                 ),
                 "updated_at" = ?
             WHERE "collection_id" = ? AND "status" != 'completed'`,
            [nowIso(), collectionId],
        );
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
            }
        });
        this.syncCollectionUploadedBytesFromCompletedChunks(collectionId);
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

    public resumeFile(fileId: string) {
        const timestamp = nowIso();
        this.kd.lib.db.run(
            `UPDATE "upload_file"
             SET "status" = 'pending', "paused_by_user" = 0, "updated_at" = ?, "error" = NULL
             WHERE "id" = ? AND "status" IN ('paused', 'pending', 'error')`,
            [timestamp, fileId],
        );
        this.syncUploadedBytesFromCompletedChunks(fileId);
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
        this.kd.lib.db.run(
            `UPDATE "upload_file"
             SET "status" = 'completed',
                 "uploaded_bytes" = "size",
                 "updated_at" = ?,
                 "error" = NULL
             WHERE "id" = ? AND "status" != 'completed'`,
            [nowIso(), fileId],
        );
    }

    public completeUpload(collectionId: string, shareLink: string) {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `UPDATE "upload_file"
                 SET "status" = 'completed', "uploaded_bytes" = "size", "updated_at" = ?, "error" = NULL
                 WHERE "collection_id" = ?`,
                [timestamp, collectionId],
            );
            tx.run(
                `UPDATE "upload_collection"
                 SET "status" = 'completed', "share_link" = ?, "updated_at" = ?, "error" = NULL
                 WHERE "id" = ?`,
                [shareLink, timestamp, collectionId],
            );
        });
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
        const summary = { transferredBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 };
        for (const file of this.listFiles(collection.id)) {
            progress[file.path] = {
                fileId: file.id,
                path: file.path,
                status: file.status,
                uploaded: file.uploadedBytes,
                size: file.size,
                error: file.error ?? undefined,
            };
            summary.transferredBytes += file.uploadedBytes;
            summary.totalBytes += file.size;
            summary.totalFiles += 1;
            if (file.status === "completed") {
                summary.completedFiles += 1;
            }
        }

        return {
            id: collection.id,
            name: collection.name,
            description: collection.description,
            passwordProtected: collection.passwordPlain != null,
            expires: collection.expires,
            shareLink: collection.shareLink,
            tree: parseTree(collection.treeJson),
            progress,
            summary,
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
                   "segment_size" AS "segmentSize",
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
                   "source_mtime_ms" AS "sourceMtimeMs",
                   "status",
                   "uploaded_bytes" AS "uploadedBytes",
                   "paused_by_user" AS "pausedByUser",
                   "created_at" AS "createdAt",
                   "updated_at" AS "updatedAt",
                   "error"
            FROM "upload_file"`;
}
