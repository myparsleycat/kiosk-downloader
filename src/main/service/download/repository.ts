import { randomUUID } from "node:crypto";

import type {
    Collection,
    DirNode,
    DownloadItem,
    DownloadStatus,
    FileDownloadStatus,
    FileNode,
    FileProgress,
    ZipNode,
} from "@shared/types";
import { normalizePath } from "@shared/utils";
import { isZipExtractMode, listZipNodes } from "@shared/zip-tree";

import type { KioskDownloader } from "../..";
import type {
    CreateDownloadRecord,
    DownloadChunkRow,
    DownloadCollectionRow,
    DownloadFileRow,
    FlatTreeFile,
    TransferFileSourceMeta,
    ZipEntryStoredMeta,
} from "./types";

import { megaChunkSizes } from "./transfer-it-crypto";
import { buildZipEntrySegmentChunks, supportsZipEntryPoolDownload } from "./zip-segment-map";

const COLLECTION_EXPIRED_ERROR = "Collection has expired.";

const COLLECTION_SELECT = `"id",
                    "share_id" AS "shareId",
                    "source_url" AS "sourceUrl",
                    "password_plain" AS "passwordPlain",
                    "name",
                    "root_id" AS "rootId",
                    "segment_size" AS "segmentSize",
                    "expires",
                    "tree_json" AS "treeJson",
                    "save_path" AS "savePath",
                    "status",
                    "created_at" AS "createdAt",
                    "updated_at" AS "updatedAt",
                    "elapsed_ms" AS "elapsedMs",
                    "error",
                    "ascii_filenames" AS "asciiFilenames",
                    COALESCE("provider", 'kiosk') AS "provider"`;

const FILE_SELECT = `"id",
                    "collection_id" AS "collectionId",
                    "remote_id" AS "remoteId",
                    "path",
                    "name",
                    "size",
                    "selected",
                    "status",
                    "downloaded_bytes" AS "downloadedBytes",
                    "paused_by_user" AS "pausedByUser",
                    "created_at" AS "createdAt",
                    "updated_at" AS "updatedAt",
                    "error",
                    COALESCE("source_kind", 'file') AS "sourceKind",
                    "zip_entry_json" AS "zipEntryJson",
                    "source_meta_json" AS "sourceMetaJson"`;

function tryParseZipEntryMeta(raw: string | null): ZipEntryStoredMeta | null {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw) as ZipEntryStoredMeta;
    } catch {
        return null;
    }
}

function isCollectionExpired(expires: number) {
    return expires * 1000 <= Date.now();
}

function requireSegmentSize(value: number) {
    if (!Number.isFinite(value) || value < 1) {
        throw new Error(`Invalid collection segment size: ${value}.`);
    }

    return Math.floor(value);
}

function getChunkCount(fileSize: number, segmentSize: number) {
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
        return 0;
    }

    return Math.ceil(fileSize / requireSegmentSize(segmentSize));
}

function nowIso() {
    return new Date().toISOString();
}

function parseTree(value: string): DirNode {
    return JSON.parse(value) as DirNode;
}

function rowToCollection(row: DownloadCollectionRow): Collection {
    return {
        shareId: row.shareId,
        name: row.name,
        expires: row.expires,
        segmentSize: row.segmentSize,
        passwordProtected: row.passwordPlain != null,
        provider: row.provider ?? "kiosk",
        tree: parseTree(row.treeJson),
    };
}

function transferSourceMetaJson(
    loaded: CreateDownloadRecord["loaded"],
    remoteId: string,
): string | null {
    if (loaded.provider !== "transfer") {
        return null;
    }
    const nodeKey = loaded.nodeKeys.get(remoteId);
    if (!nodeKey) {
        return null;
    }
    const meta: TransferFileSourceMeta = { nodeKey };
    return JSON.stringify(meta);
}

export function flattenDownloadTree(
    dir: DirNode,
    selectedPaths: Set<string>,
    zipPasswords: Record<string, string> | undefined,
    prefix: string[] = [],
    out: FlatTreeFile[] = [],
    zipContext: { remoteId: string; zipPath: string; archiveSize: number } | null = null,
) {
    for (const entry of dir.entries) {
        if (entry.kind === "file") {
            const node = entry.node as FileNode;
            const filePath = [...prefix, node.name].join("/");
            if (node.zipEntry && zipContext) {
                const meta: ZipEntryStoredMeta = {
                    ...node.zipEntry,
                    archiveSize: zipContext.archiveSize,
                    password: zipPasswords?.[zipContext.remoteId],
                };
                out.push({
                    remoteId: zipContext.remoteId,
                    path: filePath,
                    name: node.name,
                    size: node.zipEntry.uncompressedSize,
                    sourceKind: "zip_entry",
                    zipEntryJson: JSON.stringify(meta),
                    selected: isPathSelectedForExtract(filePath, selectedPaths, zipContext.zipPath),
                });
                continue;
            }
            out.push({
                remoteId: node.id,
                path: filePath,
                name: node.name,
                size: node.size,
                sourceKind: "file",
                zipEntryJson: null,
            });
            continue;
        }

        if (entry.kind === "zip") {
            const zip = entry.node as ZipNode;
            const zipPath = [...prefix, zip.name].join("/");
            if (isZipExtractMode(zipPath, selectedPaths)) {
                if (zip.entries) {
                    flattenDownloadTree(
                        { type: "dir", id: zip.id, name: zip.name, entries: zip.entries },
                        selectedPaths,
                        zipPasswords,
                        [...prefix, zip.name],
                        out,
                        { remoteId: zip.id, zipPath, archiveSize: zip.size },
                    );
                }
                continue;
            }
            out.push({
                remoteId: zip.id,
                path: zipPath,
                name: zip.name,
                size: zip.size,
                sourceKind: "file",
                zipEntryJson: null,
            });
            continue;
        }

        const child = entry.node as DirNode;
        flattenDownloadTree(
            child,
            selectedPaths,
            zipPasswords,
            [...prefix, child.name],
            out,
            zipContext,
        );
    }
    return out;
}

function isPathSelectedForExtract(filePath: string, selectedPaths: Set<string>, zipPath: string) {
    if (selectedPaths.size === 0) {
        return true;
    }
    const normalized = normalizePath(filePath);
    if (!normalized.startsWith(`${zipPath}/`)) {
        return false;
    }
    // Parent paths are ancestry markers only; full folder select stores every descendant path.
    return selectedPaths.has(normalized);
}

function isSelectedArchiveOrFile(filePath: string, selectedPaths: Set<string>, tree: DirNode) {
    if (selectedPaths.size === 0) {
        return true;
    }
    const normalized = normalizePath(filePath);
    for (const { path: zipPath } of listZipNodes(tree)) {
        if (normalized === zipPath && isZipExtractMode(zipPath, selectedPaths)) {
            return false;
        }
    }
    return selectedPaths.has(normalized);
}

function isUnderFolderPath(filePath: string, folderPath: string) {
    const file = normalizePath(filePath);
    const folder = normalizePath(folderPath);
    if (!folder) {
        return true;
    }
    return file === folder || file.startsWith(`${folder}/`);
}

export class DownloadRepository {
    public constructor(private readonly kd: KioskDownloader) {}

    public syncExpiredCollections() {
        const collections = this.kd.lib.db.all<Pick<DownloadCollectionRow, "id" | "expires">>(
            `SELECT "id", "expires"
             FROM "download_collection"
             WHERE "status" NOT IN ('completed', 'expired')`,
        );
        const timestamp = nowIso();
        for (const collection of collections) {
            if (!isCollectionExpired(collection.expires)) {
                continue;
            }
            this.kd.lib.db.run(
                `UPDATE "download_collection"
                 SET "status" = 'expired', "updated_at" = ?, "error" = ?
                 WHERE "id" = ?`,
                [timestamp, COLLECTION_EXPIRED_ERROR, collection.id],
            );
        }
    }

    public ensureCollectionNotExpired(collectionId: string) {
        const collection = this.getCollection(collectionId);
        if (!collection) {
            return true;
        }
        if (collection.status === "expired") {
            return true;
        }
        if (!isCollectionExpired(collection.expires)) {
            return false;
        }
        this.markCollectionStatus(collectionId, "expired", COLLECTION_EXPIRED_ERROR);
        return true;
    }

    public restoreStartupState(mode: "auto" | "manual") {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `DELETE FROM "download_chunk"
                 WHERE "status" = 'downloading'`,
            );
            tx.run(
                `UPDATE "download_file"
                 SET "status" = 'pending', "updated_at" = ?, "error" = NULL
                 WHERE "status" IN ('downloading', 'inflating') AND "paused_by_user" = 0`,
                [timestamp],
            );
            tx.run(
                `UPDATE "download_collection"
                 SET "status" = 'queued', "updated_at" = ?, "error" = NULL
                 WHERE "status" IN ('downloading', 'inflating')`,
                [timestamp],
            );

            if (mode === "manual") {
                tx.run(
                    `UPDATE "download_collection"
                     SET "status" = 'queued', "updated_at" = ?
                     WHERE "status" IN ('downloading', 'inflating')`,
                    [timestamp],
                );
            }
        });
    }

    public insertDownload(record: CreateDownloadRecord) {
        const collectionId = randomUUID();
        const timestamp = nowIso();
        const selectedPaths = new Set(record.selectedPaths.map((entry) => normalizePath(entry)));
        const tree = record.loaded.collection.tree;
        const treeFiles = flattenDownloadTree(tree, selectedPaths, record.zipPasswords);
        const segmentSize = requireSegmentSize(record.loaded.collection.segmentSize);
        const fileRows = treeFiles.map((file) => ({
            ...file,
            id: randomUUID(),
            selected: file.selected ?? isSelectedArchiveOrFile(file.path, selectedPaths, tree),
        }));
        const selectedCount = fileRows.filter((file) => file.selected).length;
        if (selectedCount === 0) {
            throw new Error("No files selected.");
        }

        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `INSERT INTO "download_collection"
                 ("id", "share_id", "source_url", "password_plain", "name", "root_id",
                  "segment_size", "expires", "tree_json", "save_path", "status",
                  "created_at", "updated_at", "elapsed_ms", "error", "ascii_filenames",
                  "provider")
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, NULL, ?, ?)`,
                [
                    collectionId,
                    record.loaded.collection.shareId,
                    record.url,
                    record.password || null,
                    record.loaded.collection.name,
                    record.loaded.rootId,
                    segmentSize,
                    record.loaded.collection.expires,
                    JSON.stringify(record.loaded.collection.tree),
                    record.savePath,
                    timestamp,
                    timestamp,
                    record.asciiFilenames ? 1 : 0,
                    record.loaded.provider,
                ],
            );

            for (const file of fileRows) {
                tx.run(
                    `INSERT INTO "download_file"
                     ("id", "collection_id", "remote_id", "path", "name", "size", "selected",
                      "status", "downloaded_bytes", "paused_by_user", "created_at", "updated_at",
                      "error", "source_kind", "zip_entry_json", "source_meta_json")
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, NULL, ?, ?, ?)`,
                    [
                        file.id,
                        collectionId,
                        file.remoteId,
                        file.path,
                        file.name,
                        file.size,
                        file.selected ? 1 : 0,
                        timestamp,
                        timestamp,
                        file.sourceKind,
                        file.zipEntryJson,
                        file.sourceMetaJson ?? transferSourceMetaJson(record.loaded, file.remoteId),
                    ],
                );
            }
        });

        return collectionId;
    }

    public listItems() {
        const collections = this.kd.lib.db.all<DownloadCollectionRow>(
            `SELECT ${COLLECTION_SELECT}
             FROM "download_collection"
             ORDER BY "created_at" DESC`,
        );
        return collections.map((collection) => this.buildItem(collection));
    }

    public getItem(collectionId: string) {
        const collection = this.getCollection(collectionId);
        return collection ? this.buildItem(collection) : null;
    }

    public getCollection(collectionId: string) {
        return this.kd.lib.db.get<DownloadCollectionRow>(
            `SELECT ${COLLECTION_SELECT}
             FROM "download_collection"
             WHERE "id" = ?
             LIMIT 1`,
            [collectionId],
        );
    }

    public listRunnableCollections() {
        return this.kd.lib.db.all<DownloadCollectionRow>(
            `SELECT ${COLLECTION_SELECT}
             FROM "download_collection"
             WHERE "status" IN ('queued', 'downloading', 'inflating')
             ORDER BY "created_at" ASC`,
        );
    }

    public listOsProgressRows() {
        return this.kd.lib.db.all<{
            id: string;
            status: DownloadStatus;
            transferredBytes: number;
            totalBytes: number;
        }>(
            `SELECT c."id" AS "id",
                    c."status" AS "status",
                    COALESCE(SUM(CASE WHEN f."selected" = 1 THEN f."downloaded_bytes" ELSE 0 END), 0)
                        AS "transferredBytes",
                    COALESCE(SUM(CASE WHEN f."selected" = 1 THEN f."size" ELSE 0 END), 0)
                        AS "totalBytes"
             FROM "download_collection" c
             LEFT JOIN "download_file" f ON f."collection_id" = c."id"
             WHERE c."status" NOT IN ('completed', 'expired')
             GROUP BY c."id"
             ORDER BY c."created_at" ASC`,
        );
    }

    public listFiles(collectionId: string) {
        return this.kd.lib.db.all<DownloadFileRow>(
            `SELECT ${FILE_SELECT}
             FROM "download_file"
             WHERE "collection_id" = ?
             ORDER BY "path" ASC`,
            [collectionId],
        );
    }

    public listPendingFiles(collectionId: string) {
        return this.kd.lib.db.all<DownloadFileRow>(
            `SELECT ${FILE_SELECT}
             FROM "download_file"
             WHERE "collection_id" = ?
               AND "selected" = 1
               AND "status" = 'pending'
             ORDER BY "created_at" ASC, "path" ASC`,
            [collectionId],
        );
    }

    public hasPendingFile(collectionId: string, excludedFileIds: Iterable<string> = []) {
        const excluded = [...excludedFileIds];
        const row = this.kd.lib.db.get<{ found: number }>(
            `SELECT 1 AS "found"
             FROM "download_file"
             WHERE "collection_id" = ?
               AND "selected" = 1
               AND "status" = 'pending'
               ${excluded.length > 0 ? `AND "id" NOT IN (${excluded.map(() => "?").join(", ")})` : ""}
             LIMIT 1`,
            [collectionId, ...excluded],
        );
        return row?.found === 1;
    }

    public getNextPendingFile(
        collectionId: string,
        prioritizedFileIds: Iterable<string> = [],
        excludedFileIds: Iterable<string> = [],
    ) {
        const prioritized = [...prioritizedFileIds].slice(0, 400);
        const excluded = [...excludedFileIds];
        return this.kd.lib.db.get<DownloadFileRow>(
            `SELECT ${FILE_SELECT}
             FROM "download_file"
             WHERE "collection_id" = ?
               AND "selected" = 1
               AND "status" = 'pending'
               ${excluded.length > 0 ? `AND "id" NOT IN (${excluded.map(() => "?").join(", ")})` : ""}
             ORDER BY ${prioritized.length > 0 ? `CASE WHEN "id" IN (${prioritized.map(() => "?").join(", ")}) THEN 0 ELSE 1 END,` : ""}
                      "created_at" ASC, "path" ASC
             LIMIT 1`,
            [collectionId, ...excluded, ...prioritized],
        );
    }

    public getFilesByIds(collectionId: string, fileIds: Iterable<string>) {
        const ids = [...new Set(fileIds)];
        if (ids.length === 0) {
            return [];
        }

        return ids.flatMap((_, offset) => {
            if (offset % 400 !== 0) {
                return [];
            }
            const batch = ids.slice(offset, offset + 400);
            return this.kd.lib.db.all<DownloadFileRow>(
                `SELECT ${FILE_SELECT}
                 FROM "download_file"
                 WHERE "collection_id" = ?
                   AND "id" IN (${batch.map(() => "?").join(", ")})`,
                [collectionId, ...batch],
            );
        });
    }

    public getSummary(collectionId: string) {
        const row = this.kd.lib.db.get<{
            transferredBytes: number | null;
            totalBytes: number | null;
            completedFiles: number;
            totalFiles: number;
        }>(
            `SELECT COALESCE(SUM("downloaded_bytes"), 0) AS "transferredBytes",
                    COALESCE(SUM("size"), 0) AS "totalBytes",
                    SUM(CASE WHEN "status" = 'completed' THEN 1 ELSE 0 END) AS "completedFiles",
                    COUNT(*) AS "totalFiles"
             FROM "download_file"
             WHERE "collection_id" = ? AND "selected" = 1`,
            [collectionId],
        );
        return {
            transferredBytes: Number(row?.transferredBytes ?? 0),
            totalBytes: Number(row?.totalBytes ?? 0),
            completedFiles: Number(row?.completedFiles ?? 0),
            totalFiles: Number(row?.totalFiles ?? 0),
        };
    }

    public getFile(fileId: string) {
        return this.kd.lib.db.get<DownloadFileRow>(
            `SELECT ${FILE_SELECT}
             FROM "download_file"
             WHERE "id" = ?
             LIMIT 1`,
            [fileId],
        );
    }

    public listChunks(fileId: string) {
        const file = this.getFile(fileId);
        const collection = file ? this.getCollection(file.collectionId) : null;
        return file && collection ? this.buildChunks(collection, file) : [];
    }

    public listPendingChunks(fileId: string) {
        return this.listChunks(fileId).filter(
            (chunk) => chunk.status === "pending" || chunk.status === "error",
        );
    }

    public markCollectionStatus(
        collectionId: string,
        status: DownloadStatus,
        error?: string | null,
    ) {
        this.kd.lib.db.run(
            `UPDATE "download_collection"
             SET "status" = ?, "updated_at" = ?, "error" = ?
             WHERE "id" = ?`,
            [status, nowIso(), error ?? null, collectionId],
        );
    }

    public addCollectionElapsedMs(collectionId: string, deltaMs: number) {
        // Monotonic timers should only produce positive deltas; ignore invalid values defensively.
        if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
            return;
        }

        this.kd.lib.db.run(
            `UPDATE "download_collection"
             SET "elapsed_ms" = "elapsed_ms" + ?, "updated_at" = ?
             WHERE "id" = ?`,
            [Math.round(deltaMs), nowIso(), collectionId],
        );
    }

    public getCollectionElapsedMs(collectionId: string) {
        const row = this.kd.lib.db.get<{ elapsedMs: number }>(
            `SELECT "elapsed_ms" AS "elapsedMs"
             FROM "download_collection"
             WHERE "id" = ?
             LIMIT 1`,
            [collectionId],
        );
        return row?.elapsedMs ?? 0;
    }

    public updateCollectionFreshMeta(collectionId: string, meta: { expires: number }) {
        this.kd.lib.db.run(
            `UPDATE "download_collection"
             SET "expires" = ?, "updated_at" = ?
             WHERE "id" = ?`,
            [meta.expires, nowIso(), collectionId],
        );
    }

    public markFileStatus(fileId: string, status: FileDownloadStatus, error?: string | null) {
        this.kd.lib.db.run(
            `UPDATE "download_file"
             SET "status" = ?, "updated_at" = ?, "error" = ?
             WHERE "id" = ?`,
            [status, nowIso(), error ?? null, fileId],
        );
    }

    public setFilePausedByUser(fileId: string, paused: boolean) {
        this.kd.lib.db.run(
            `UPDATE "download_file"
             SET "paused_by_user" = ?, "updated_at" = ?
             WHERE "id" = ?`,
            [paused ? 1 : 0, nowIso(), fileId],
        );
    }

    public markChunkDownloading(chunk: DownloadChunkRow) {
        this.kd.lib.db.run(
            `INSERT INTO "download_chunk"
             ("collection_id", "file_id", "chunk_index", "offset", "size", "status",
              "downloaded_bytes", "attempts", "updated_at", "error")
             VALUES (?, ?, ?, ?, ?, 'downloading', 0, 1, ?, NULL)
             ON CONFLICT("file_id", "chunk_index") DO UPDATE
             SET "collection_id" = excluded."collection_id",
                 "offset" = excluded."offset",
                 "size" = excluded."size",
                 "status" = 'downloading',
                 "downloaded_bytes" = 0,
                 "attempts" = "download_chunk"."attempts" + 1,
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

    public markChunkCompleted(chunk: DownloadChunkRow, bytes: number) {
        this.kd.lib.db.run(
            `INSERT INTO "download_chunk"
             ("collection_id", "file_id", "chunk_index", "offset", "size", "status",
              "downloaded_bytes", "attempts", "updated_at", "error")
             VALUES (?, ?, ?, ?, ?, 'completed', ?, 0, ?, NULL)
             ON CONFLICT("file_id", "chunk_index") DO UPDATE
             SET "collection_id" = excluded."collection_id",
                 "offset" = excluded."offset",
                 "size" = excluded."size",
                 "status" = 'completed',
                 "downloaded_bytes" = excluded."downloaded_bytes",
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
        this.kd.lib.db.run(
            `DELETE FROM "download_chunk"
             WHERE "file_id" = ? AND "chunk_index" = ?`,
            [fileId, chunkIndex],
        );
    }

    public markChunkError(chunk: DownloadChunkRow, error: string) {
        this.kd.lib.db.run(
            `INSERT INTO "download_chunk"
             ("collection_id", "file_id", "chunk_index", "offset", "size", "status",
              "downloaded_bytes", "attempts", "updated_at", "error")
             VALUES (?, ?, ?, ?, ?, 'error', 0, 0, ?, ?)
             ON CONFLICT("file_id", "chunk_index") DO UPDATE
             SET "collection_id" = excluded."collection_id",
                 "offset" = excluded."offset",
                 "size" = excluded."size",
                 "status" = 'error',
                 "downloaded_bytes" = 0,
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
            `DELETE FROM "download_chunk"
             WHERE "file_id" = ? AND "status" = 'downloading'`,
            [fileId],
        );
    }

    public resetErroredChunksForFile(fileId: string) {
        this.kd.lib.db.run(
            `DELETE FROM "download_chunk"
             WHERE "file_id" = ? AND "status" = 'error'`,
            [fileId],
        );
    }

    public hasErroredChunk(fileId: string) {
        const row = this.kd.lib.db.get<{ count: number }>(
            `SELECT COUNT(*) AS "count"
             FROM "download_chunk"
             WHERE "file_id" = ? AND "status" = 'error'`,
            [fileId],
        );
        return Number(row?.count ?? 0) > 0;
    }

    public pauseCollection(collectionId: string) {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `UPDATE "download_collection"
                 SET "status" = 'paused', "updated_at" = ?, "error" = NULL
                 WHERE "id" = ?`,
                [timestamp, collectionId],
            );
            tx.run(
                `UPDATE "download_file"
                 SET "status" = 'paused', "updated_at" = ?, "error" = NULL
                 WHERE "collection_id" = ?
                   AND "selected" = 1
                   AND "status" IN ('pending', 'downloading', 'inflating')
                   AND "paused_by_user" = 0`,
                [timestamp, collectionId],
            );
            tx.run(
                `DELETE FROM "download_chunk"
                 WHERE "collection_id" = ? AND "status" = 'downloading'`,
                [collectionId],
            );
        });
    }

    public resumeCollection(collectionId: string, force: boolean) {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `UPDATE "download_collection"
                 SET "status" = 'queued', "updated_at" = ?, "error" = NULL
                 WHERE "id" = ?`,
                [timestamp, collectionId],
            );
            tx.run(
                `UPDATE "download_file"
                 SET "status" = 'pending',
                     "paused_by_user" = 0,
                     "updated_at" = ?,
                     "error" = NULL
                 WHERE "collection_id" = ?
                   AND "selected" = 1
                   AND "status" = 'paused'`,
                [timestamp, collectionId],
            );
            if (force) {
                tx.run(
                    `UPDATE "download_file"
                     SET "status" = 'pending',
                         "paused_by_user" = 0,
                         "updated_at" = ?,
                         "error" = NULL
                     WHERE "collection_id" = ?
                       AND "selected" = 1
                       AND "status" = 'error'`,
                    [timestamp, collectionId],
                );
                tx.run(
                    `DELETE FROM "download_chunk"
                     WHERE "collection_id" = ? AND "status" = 'error'`,
                    [collectionId],
                );
            }
        });
    }

    public pauseFile(fileId: string) {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `UPDATE "download_file"
                 SET "status" = 'paused', "paused_by_user" = 1, "updated_at" = ?, "error" = NULL
                 WHERE "id" = ? AND "status" != 'completed'`,
                [timestamp, fileId],
            );
            tx.run(
                `DELETE FROM "download_chunk"
                 WHERE "file_id" = ? AND "status" = 'downloading'`,
                [fileId],
            );
        });
    }

    public resumeFile(fileId: string, force: boolean) {
        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            tx.run(
                `UPDATE "download_file"
                 SET "status" = 'pending',
                     "paused_by_user" = 0,
                     "updated_at" = ?,
                     "error" = NULL
                 WHERE "id" = ? AND "status" IN ('paused', 'pending', 'error')`,
                [timestamp, fileId],
            );
            if (force) {
                tx.run(
                    `DELETE FROM "download_chunk"
                     WHERE "file_id" = ? AND "status" = 'error'`,
                    [fileId],
                );
            }
        });
    }

    public includeFile(fileId: string) {
        const file = this.getFile(fileId);
        if (!file) {
            throw new Error("File not found.");
        }
        if (file.selected === 1) {
            return;
        }

        const timestamp = nowIso();
        this.kd.lib.db.run(
            `UPDATE "download_file"
             SET "selected" = 1,
                 "status" = 'pending',
                 "paused_by_user" = 0,
                 "updated_at" = ?,
                 "error" = NULL
             WHERE "id" = ?`,
            [timestamp, fileId],
        );
    }

    public includeFolder(collectionId: string, folderPath: string) {
        const files = this.listFiles(collectionId).filter(
            (file) => file.selected === 0 && isUnderFolderPath(file.path, folderPath),
        );
        if (files.length === 0) {
            return [];
        }

        const timestamp = nowIso();
        this.kd.lib.db.transaction((tx) => {
            for (const file of files) {
                tx.run(
                    `UPDATE "download_file"
                     SET "selected" = 1,
                         "status" = 'pending',
                         "paused_by_user" = 0,
                         "updated_at" = ?,
                         "error" = NULL
                     WHERE "id" = ?`,
                    [timestamp, file.id],
                );
            }
        });

        return files.map((file) => file.id);
    }

    public syncFileDownloadedBytes(fileId: string) {
        const row = this.kd.lib.db.get<{ downloaded: number | null }>(
            `SELECT SUM("downloaded_bytes") AS "downloaded"
             FROM "download_chunk"
             WHERE "file_id" = ? AND "status" = 'completed'`,
            [fileId],
        );
        const file = this.getFile(fileId);
        if (!file) {
            return;
        }
        const downloaded = Math.min(file.size, Math.max(0, Number(row?.downloaded ?? 0)));
        this.kd.lib.db.run(
            `UPDATE "download_file"
             SET "downloaded_bytes" = ?, "updated_at" = ?
             WHERE "id" = ?`,
            [downloaded, nowIso(), fileId],
        );
    }

    public syncScaledDownloadedBytes(fileId: string, sourceTotal: number, displayTotal: number) {
        const row = this.kd.lib.db.get<{ downloaded: number | null }>(
            `SELECT SUM("downloaded_bytes") AS "downloaded"
             FROM "download_chunk"
             WHERE "file_id" = ? AND "status" = 'completed'`,
            [fileId],
        );
        const file = this.getFile(fileId);
        if (!file) {
            return;
        }
        const sourceDownloaded = Math.max(0, Number(row?.downloaded ?? 0));
        const scaled =
            sourceTotal <= 0 ? 0 : Math.floor((sourceDownloaded / sourceTotal) * displayTotal);
        const downloaded = Math.min(file.size, Math.max(0, scaled));
        this.kd.lib.db.run(
            `UPDATE "download_file"
             SET "downloaded_bytes" = ?, "updated_at" = ?
             WHERE "id" = ?`,
            [downloaded, nowIso(), fileId],
        );
    }

    public updateZipEntryJson(fileId: string, meta: ZipEntryStoredMeta) {
        this.kd.lib.db.run(
            `UPDATE "download_file"
             SET "zip_entry_json" = ?, "updated_at" = ?
             WHERE "id" = ?`,
            [JSON.stringify(meta), nowIso(), fileId],
        );
    }

    public deleteAllChunksForFile(fileId: string) {
        this.kd.lib.db.run(`DELETE FROM "download_chunk" WHERE "file_id" = ?`, [fileId]);
    }

    public addFileDownloadedBytes(fileId: string, bytes: number) {
        this.kd.lib.db.run(
            `UPDATE "download_file"
             SET "downloaded_bytes" = MIN("size", "downloaded_bytes" + ?), "updated_at" = ?
             WHERE "id" = ?`,
            [bytes, nowIso(), fileId],
        );
    }

    public setFileDownloadedBytes(fileId: string, bytes: number) {
        const file = this.getFile(fileId);
        if (!file) {
            return;
        }
        const downloaded = Math.min(file.size, Math.max(0, bytes));
        this.kd.lib.db.run(
            `UPDATE "download_file"
             SET "downloaded_bytes" = ?, "updated_at" = ?
             WHERE "id" = ?`,
            [downloaded, nowIso(), fileId],
        );
    }

    public completeFile(fileId: string) {
        this.kd.lib.db.run(
            `UPDATE "download_file"
             SET "status" = 'completed',
                 "downloaded_bytes" = "size",
                 "updated_at" = ?,
                 "error" = NULL
             WHERE "id" = ? AND "status" != 'completed'`,
            [nowIso(), fileId],
        );
    }

    public deleteCollection(collectionId: string) {
        this.kd.lib.db.run(`DELETE FROM "download_collection" WHERE "id" = ?`, [collectionId]);
    }

    public recomputeCollectionStatus(collectionId: string) {
        const collection = this.getCollection(collectionId);
        if (!collection || collection.status === "paused" || collection.status === "expired") {
            return;
        }

        const state = this.kd.lib.db.get<{
            pending: number;
            downloading: number;
            inflating: number;
            paused: number;
            completed: number;
            error: number;
        }>(
            `SELECT EXISTS(
                        SELECT 1 FROM "download_file"
                        WHERE "collection_id" = ? AND "selected" = 1 AND "status" = 'pending'
                    ) AS "pending",
                    EXISTS(
                        SELECT 1 FROM "download_file"
                        WHERE "collection_id" = ? AND "selected" = 1 AND "status" = 'downloading'
                    ) AS "downloading",
                    EXISTS(
                        SELECT 1 FROM "download_file"
                        WHERE "collection_id" = ? AND "selected" = 1 AND "status" = 'inflating'
                    ) AS "inflating",
                    EXISTS(
                        SELECT 1 FROM "download_file"
                        WHERE "collection_id" = ? AND "selected" = 1 AND "status" = 'paused'
                    ) AS "paused",
                    EXISTS(
                        SELECT 1 FROM "download_file"
                        WHERE "collection_id" = ? AND "selected" = 1 AND "status" = 'completed'
                    ) AS "completed",
                    EXISTS(
                        SELECT 1 FROM "download_file"
                        WHERE "collection_id" = ? AND "selected" = 1 AND "status" = 'error'
                    ) AS "error"`,
            [collectionId, collectionId, collectionId, collectionId, collectionId, collectionId],
        );
        const pending = state?.pending === 1;
        const downloading = state?.downloading === 1;
        const inflating = state?.inflating === 1;
        const paused = state?.paused === 1;
        const completed = state?.completed === 1;
        const error = state?.error === 1;
        if (!pending && !downloading && !inflating && !paused && !completed && !error) {
            this.markCollectionStatus(collectionId, "completed");
            return;
        }
        if (completed && !pending && !downloading && !inflating && !paused && !error) {
            this.markCollectionStatus(collectionId, "completed");
            return;
        }
        if (downloading) {
            this.markCollectionStatus(collectionId, "downloading");
            return;
        }
        if (inflating) {
            this.markCollectionStatus(collectionId, "inflating");
            return;
        }
        if (paused && !pending && !error) {
            this.markCollectionStatus(collectionId, "paused");
            return;
        }
        if (error && !pending && !paused) {
            this.markCollectionStatus(collectionId, "error");
            return;
        }

        this.markCollectionStatus(collectionId, "queued");
    }

    private buildChunks(collection: DownloadCollectionRow, file: DownloadFileRow) {
        const storedByIndex = new Map(
            this.kd.lib.db
                .all<DownloadChunkRow>(
                    `SELECT "collection_id" AS "collectionId",
                            "file_id" AS "fileId",
                            "chunk_index" AS "chunkIndex",
                            "offset",
                            "size",
                            "status",
                            "downloaded_bytes" AS "downloadedBytes",
                            "attempts",
                            "updated_at" AS "updatedAt",
                            "error"
                     FROM "download_chunk"
                     WHERE "file_id" = ? AND "status" IN ('downloading', 'completed', 'error')
                     ORDER BY "chunk_index" ASC`,
                    [file.id],
                )
                .map((chunk) => [chunk.chunkIndex, chunk]),
        );

        if (file.sourceKind === "zip_entry") {
            if (file.size <= 0) {
                return [];
            }

            const meta = tryParseZipEntryMeta(file.zipEntryJson);
            if (meta && typeof meta.dataOffset === "number" && supportsZipEntryPoolDownload(meta)) {
                const spans = buildZipEntrySegmentChunks(
                    meta.dataOffset,
                    meta.compressedSize,
                    requireSegmentSize(collection.segmentSize),
                    meta.archiveSize,
                );
                return spans.map((span) => {
                    const stored = storedByIndex.get(span.chunkIndex);
                    if (stored) {
                        return {
                            ...stored,
                            collectionId: collection.id,
                            fileId: file.id,
                            offset: span.offset,
                            size: span.size,
                        };
                    }
                    return {
                        collectionId: collection.id,
                        fileId: file.id,
                        chunkIndex: span.chunkIndex,
                        offset: span.offset,
                        size: span.size,
                        status: "pending" as const,
                        downloadedBytes: 0,
                        attempts: 0,
                        updatedAt: file.updatedAt,
                        error: null,
                    };
                });
            }

            const stored = storedByIndex.get(0);
            if (stored) {
                return [
                    {
                        ...stored,
                        collectionId: collection.id,
                        fileId: file.id,
                        offset: 0,
                        size: file.size,
                    },
                ];
            }
            return [
                {
                    collectionId: collection.id,
                    fileId: file.id,
                    chunkIndex: 0,
                    offset: 0,
                    size: file.size,
                    status: "pending" as const,
                    downloadedBytes: 0,
                    attempts: 0,
                    updatedAt: file.updatedAt,
                    error: null,
                },
            ];
        }

        if ((collection.provider ?? "kiosk") === "transfer") {
            return megaChunkSizes(file.size).map((chunk, chunkIndex) => {
                const stored = storedByIndex.get(chunkIndex);
                if (stored) {
                    return {
                        ...stored,
                        collectionId: collection.id,
                        fileId: file.id,
                        offset: chunk.start,
                        size: chunk.size,
                    };
                }
                return {
                    collectionId: collection.id,
                    fileId: file.id,
                    chunkIndex,
                    offset: chunk.start,
                    size: chunk.size,
                    status: "pending" as const,
                    downloadedBytes: 0,
                    attempts: 0,
                    updatedAt: file.updatedAt,
                    error: null,
                };
            });
        }

        const segmentSize = requireSegmentSize(collection.segmentSize);

        return Array.from({ length: getChunkCount(file.size, segmentSize) }, (_, chunkIndex) => {
            const offset = chunkIndex * segmentSize;
            const size = Math.min(segmentSize, file.size - offset);
            const stored = storedByIndex.get(chunkIndex);
            if (stored) {
                return {
                    ...stored,
                    collectionId: collection.id,
                    fileId: file.id,
                    offset,
                    size,
                };
            }

            return {
                collectionId: collection.id,
                fileId: file.id,
                chunkIndex,
                offset,
                size,
                status: "pending" as const,
                downloadedBytes: 0,
                attempts: 0,
                updatedAt: file.updatedAt,
                error: null,
            };
        });
    }

    private buildItem(collection: DownloadCollectionRow): DownloadItem {
        const progress: Record<string, FileProgress> = {};
        const summary = { transferredBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 };
        for (const file of this.listFiles(collection.id)) {
            progress[file.path] = {
                fileId: file.id,
                path: file.path,
                status: file.status,
                downloaded: file.downloadedBytes,
                size: file.size,
                selected: file.selected === 1,
                error: file.error ?? undefined,
            };
            if (file.selected === 1) {
                summary.transferredBytes += file.downloadedBytes;
                summary.totalBytes += file.size;
                summary.totalFiles += 1;
                if (file.status === "completed") {
                    summary.completedFiles += 1;
                }
            }
        }

        return {
            id: collection.id,
            collection: rowToCollection(collection),
            savePath: collection.savePath,
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
