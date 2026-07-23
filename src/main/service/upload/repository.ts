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
    UploadBundleRow,
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

    public restoreStartupState() {
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
                  "created_at", "updated_at", "elapsed_ms", "error", "bundle_id", "ordinal", "superseded")
                 VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, NULL, ?, ?, 0)`,
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
                    record.bundleId ?? null,
                    record.ordinal ?? 0,
                ],
            );

            for (const file of fileRows) {
                tx.run(
                    `INSERT INTO "upload_file"
                     ("id", "collection_id", "remote_id", "path", "name", "size", "fs_path", "source_mtime_ms",
                      "status", "uploaded_bytes", "paused_by_user", "created_at", "updated_at", "error",
                      "logical_path", "source_offset", "logical_size", "logical_sha256")
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, NULL, ?, ?, ?, ?)`,
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
                        file.logicalPath ?? file.path,
                        file.sourceOffset ?? 0,
                        file.logicalSize ?? file.size,
                        file.logicalSha256 ?? null,
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
        return [
            ...this.listBundles().map((bundle) => this.buildBundleItem(bundle)),
            ...collections
                .filter((collection) => !collection.bundleId)
                .map((collection) => this.buildItem(collection)),
        ].sort((left, right) => right.createdAt - left.createdAt);
    }

    public getItem(collectionId: string): UploadItem | null {
        const bundle = this.getBundle(collectionId);
        if (bundle) {
            return this.buildBundleItem(bundle);
        }
        const collection = this.getCollection(collectionId);
        return collection ? this.buildItem(collection) : null;
    }

    public insertBundle(record: {
        id: string;
        mode: UploadBundleRow["mode"];
        name: string;
        description: string;
        password: string;
        treeJson: string;
        planJson: string;
        physicalCount: number;
        expires: number;
    }) {
        const timestamp = nowIso();
        this.kd.lib.db.run(
            `INSERT INTO "upload_bundle"
             ("id", "mode", "name", "description", "password_plain", "tree_json", "plan_json",
              "physical_count", "initialized_count", "share_value", "status", "expires",
              "created_at", "updated_at", "error")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'paused', ?, ?, ?, NULL)`,
            [
                record.id,
                record.mode,
                record.name,
                record.description,
                record.password || null,
                record.treeJson,
                record.planJson,
                record.physicalCount,
                record.expires,
                timestamp,
                timestamp,
            ],
        );
    }

    public listBundles(): UploadBundleRow[] {
        return this.kd.lib.db.all<UploadBundleRow>(
            bundleSelectSql() + ` ORDER BY "created_at" DESC`,
        );
    }

    public getBundle(bundleId: string): UploadBundleRow | null {
        return this.kd.lib.db.get<UploadBundleRow>(bundleSelectSql() + ` WHERE "id" = ? LIMIT 1`, [
            bundleId,
        ]);
    }

    public listBundleCollections(bundleId: string): UploadCollectionRow[] {
        return this.kd.lib.db.all<UploadCollectionRow>(
            collectionSelectSql() +
                ` WHERE "bundle_id" = ? AND "superseded" = 0 ORDER BY "ordinal" ASC`,
            [bundleId],
        );
    }

    public getBundleByCollection(collectionId: string): UploadBundleRow | null {
        return this.kd.lib.db.get<UploadBundleRow>(
            bundleSelectSql() +
                ` WHERE "id" = (SELECT "bundle_id" FROM "upload_collection" WHERE "id" = ?) LIMIT 1`,
            [collectionId],
        );
    }

    public listBundleFiles(bundleId: string): UploadFileRow[] {
        return this.kd.lib.db.all<UploadFileRow>(
            fileSelectSql() +
                ` WHERE "collection_id" IN (
                    SELECT "id" FROM "upload_collection"
                    WHERE "bundle_id" = ? AND "superseded" = 0
                ) ORDER BY "logical_path" ASC, "source_offset" ASC`,
            [bundleId],
        );
    }

    public updateBundleInitialization(bundleId: string, initializedCount: number) {
        this.kd.lib.db.run(
            `UPDATE "upload_bundle"
             SET "initialized_count" = ?, "status" = ?, "updated_at" = ?, "error" = NULL
             WHERE "id" = ?`,
            [initializedCount, initializedCount > 0 ? "queued" : "paused", nowIso(), bundleId],
        );
    }

    public queueBundle(bundleId: string) {
        this.kd.lib.db.run(
            `UPDATE "upload_bundle" SET "status" = 'queued', "updated_at" = ?, "error" = NULL WHERE "id" = ?`,
            [nowIso(), bundleId],
        );
    }

    public markBundleStatus(bundleId: string, status: UploadStatus, error?: string | null) {
        this.kd.lib.db.run(
            `UPDATE "upload_bundle" SET "status" = ?, "updated_at" = ?, "error" = ? WHERE "id" = ?`,
            [status, nowIso(), error ?? null, bundleId],
        );
    }

    public completeBundle(bundleId: string, shareValue: string) {
        this.kd.lib.db.run(
            `UPDATE "upload_bundle"
             SET "status" = 'completed', "share_value" = ?, "updated_at" = ?, "error" = NULL
             WHERE "id" = ?`,
            [shareValue, nowIso(), bundleId],
        );
    }

    public supersedeCollection(collectionId: string) {
        this.kd.lib.db.run(
            `UPDATE "upload_collection" SET "superseded" = 1, "updated_at" = ? WHERE "id" = ?`,
            [nowIso(), collectionId],
        );
    }

    public deleteBundle(bundleId: string) {
        this.kd.lib.db.run(`DELETE FROM "upload_bundle" WHERE "id" = ?`, [bundleId]);
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
                ` WHERE "status" IN ('queued', 'uploading')
                    AND "superseded" = 0
                    AND (
                        "bundle_id" IS NULL
                        OR EXISTS (
                            SELECT 1 FROM "upload_bundle" ready
                            WHERE ready."id" = "upload_collection"."bundle_id"
                              AND ready."initialized_count" = ready."physical_count"
                              AND NOT EXISTS (
                                  SELECT 1
                                  FROM "upload_collection" previous
                                  WHERE previous."bundle_id" = ready."id"
                                    AND ready."mode" = 'integrated'
                                    AND previous."superseded" = 0
                                    AND previous."ordinal" < "upload_collection"."ordinal"
                                    AND previous."status" != 'completed'
                              )
                        )
                    )
                  ORDER BY "created_at" ASC`,
        );
    }

    public listOsProgressRows() {
        return this.kd.lib.db.all<{
            id: string;
            bundleId: string | null;
            status: UploadStatus;
            transferredBytes: number;
            totalBytes: number;
        }>(
            `SELECT c."id" AS "id",
                    c."bundle_id" AS "bundleId",
                    c."status" AS "status",
                    COALESCE(SUM(f."uploaded_bytes"), 0) AS "transferredBytes",
                    COALESCE(SUM(f."size"), 0) AS "totalBytes"
             FROM "upload_collection" c
             LEFT JOIN "upload_file" f ON f."collection_id" = c."id"
             LEFT JOIN "upload_bundle" b ON b."id" = c."bundle_id"
             WHERE c."superseded" = 0
               AND (
                   (c."bundle_id" IS NULL AND c."status" NOT IN ('completed', 'expired'))
                   OR
                   (c."bundle_id" IS NOT NULL AND b."status" NOT IN ('completed', 'expired'))
               )
             GROUP BY c."id"
             ORDER BY c."created_at" ASC`,
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
            this.markCollectionStatus(collectionId, "error");
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

    private buildBundleItem(bundle: UploadBundleRow): UploadItem {
        const collections = this.listBundleCollections(bundle.id);
        const files = collections.flatMap((collection) => this.listFiles(collection.id));
        const progress: UploadItem["progress"] = {};
        const summary = { transferredBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 };
        const packedPhysicalPaths = new Set<string>();
        const plan = JSON.parse(bundle.planJson) as {
            collections: Array<{
                files: Array<{
                    path: string;
                    packEntries?: Array<{ path: string; size: number }>;
                }>;
            }>;
        };
        for (const [ordinal, plannedCollection] of plan.collections.entries()) {
            const collection = collections.find((candidate) => candidate.ordinal === ordinal);
            if (!collection) continue;
            for (const plannedFile of plannedCollection.files) {
                if (!plannedFile.packEntries) continue;
                packedPhysicalPaths.add(`${collection.id}\0${plannedFile.path}`);
                const physical = files.find(
                    (file) => file.collectionId === collection.id && file.path === plannedFile.path,
                );
                for (const entry of plannedFile.packEntries) {
                    const uploaded = physical
                        ? Math.floor(
                              entry.size * Math.min(1, physical.uploadedBytes / physical.size),
                          )
                        : 0;
                    const status = physical?.status ?? "pending";
                    progress[entry.path] = {
                        fileId: physical
                            ? `${physical.id}::pack::${encodeURIComponent(entry.path)}`
                            : `${bundle.id}:${ordinal}:${entry.path}`,
                        path: entry.path,
                        status,
                        uploaded,
                        size: entry.size,
                        error: physical?.error ?? undefined,
                    };
                    summary.transferredBytes += uploaded;
                    summary.totalBytes += entry.size;
                    summary.totalFiles += 1;
                    if (status === "completed") summary.completedFiles += 1;
                }
            }
        }
        const byLogicalPath = new Map<string, UploadFileRow[]>();
        for (const file of files) {
            if (packedPhysicalPaths.has(`${file.collectionId}\0${file.path}`)) continue;
            const logicalPath = file.logicalPath ?? file.path;
            const entries = byLogicalPath.get(logicalPath) ?? [];
            entries.push(file);
            byLogicalPath.set(logicalPath, entries);
        }

        for (const [logicalPath, pieces] of byLogicalPath) {
            const size =
                pieces[0].logicalSize ?? pieces.reduce((sum, piece) => sum + piece.size, 0);
            const uploaded = Math.min(
                size,
                pieces.reduce((sum, piece) => sum + piece.uploadedBytes, 0),
            );
            const status = pieces.some((piece) => piece.status === "error")
                ? "error"
                : pieces.every((piece) => piece.status === "completed")
                  ? "completed"
                  : pieces.some((piece) => piece.status === "uploading")
                    ? "uploading"
                    : pieces.some((piece) => piece.status === "paused")
                      ? "paused"
                      : "pending";
            progress[logicalPath] = {
                fileId: pieces[0].id,
                path: logicalPath,
                status,
                uploaded,
                size,
                error: pieces.find((piece) => piece.error)?.error ?? undefined,
            };
            summary.transferredBytes += uploaded;
            summary.totalBytes += size;
            summary.totalFiles += 1;
            if (status === "completed") summary.completedFiles += 1;
        }

        const activeStatus = collections.some(
            (collection) => collection.status === "error" || collection.status === "expired",
        )
            ? "error"
            : collections.length === bundle.physicalCount &&
                collections.every((collection) => collection.status === "completed")
              ? "completed"
              : collections.some((collection) => collection.status === "uploading")
                ? "uploading"
                : bundle.status;
        const elapsedMs = collections.reduce((sum, collection) => sum + collection.elapsedMs, 0);

        return {
            id: bundle.id,
            name: bundle.name,
            description: bundle.description,
            passwordProtected: bundle.passwordPlain != null,
            expires: bundle.expires,
            shareLink: null,
            shareValue: bundle.shareValue,
            shareKind: bundle.mode === "integrated" ? "extended" : "compatibility-list",
            tree: parseTree(bundle.treeJson),
            progress,
            summary,
            status: activeStatus,
            mode: bundle.mode,
            phase:
                bundle.initializedCount < bundle.physicalCount
                    ? "initializing"
                    : activeStatus === "completed"
                      ? "completed"
                      : "uploading",
            physicalCollectionCount: bundle.physicalCount,
            initializedCollectionCount: bundle.initializedCount,
            requiresReplacement: collections.some(
                (collection) => collection.status === "error" || collection.status === "expired",
            ),
            createdAt: Date.parse(bundle.createdAt),
            updatedAt: Math.max(
                Date.parse(bundle.updatedAt),
                ...collections.map((collection) => Date.parse(collection.updatedAt)),
            ),
            elapsedMs,
            error:
                collections.find(
                    (collection) =>
                        collection.status === "error" || collection.status === "expired",
                )?.error ??
                bundle.error ??
                undefined,
        };
    }
}

function bundleSelectSql() {
    return `SELECT "id",
                   "mode",
                   "name",
                   "description",
                   "password_plain" AS "passwordPlain",
                   "tree_json" AS "treeJson",
                   "plan_json" AS "planJson",
                   "physical_count" AS "physicalCount",
                   "initialized_count" AS "initializedCount",
                   "share_value" AS "shareValue",
                   "status",
                   "expires",
                   "created_at" AS "createdAt",
                   "updated_at" AS "updatedAt",
                   "error"
            FROM "upload_bundle"`;
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
                   "error",
                   "bundle_id" AS "bundleId",
                   "ordinal",
                   "superseded"
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
                   "error",
                   "logical_path" AS "logicalPath",
                   "source_offset" AS "sourceOffset",
                   "logical_size" AS "logicalSize",
                   "logical_sha256" AS "logicalSha256"
            FROM "upload_file"`;
}
