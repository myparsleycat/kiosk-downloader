import path from "node:path";

import { shouldCreateCollectionSubfolder } from "@shared/collection-path";
import { tryParseDownloadUrl } from "@shared/share-url";
import type {
    CreateDownloadPayload,
    DownloadItem,
    DownloadProgressPatch,
    FileProgress,
    ListZipEntriesPayload,
    ListZipEntriesResult,
    LoadCollectionPayload,
    ProbeCollectionPayload,
    ResumePayload,
} from "@shared/types";
import { toErrorMessage } from "@shared/utils";
import { findZipNodeById, isZipExtractMode, listZipNodes, setZipEntries } from "@shared/zip-tree";
import { shell } from "electron";
import fg from "fast-glob";
import fse from "fs-extra";

import type { KioskDownloader } from "../..";
import type {
    DownloadCollectionRow,
    DownloadFileRow,
    LoadedCollection,
    LoadedKioskCollection,
} from "./types";

import { toOsProgressTransfer } from "../os-progress-bar";
import { showOpenDialog, showSaveDialog } from "../util";
import { KioApiClient } from "./kio-api-client";
import { DownloadTransferMetrics } from "./metrics";
import { PartFileWriter, getStagingPartPath } from "./part-file";
import { DownloadRepository } from "./repository";
import { DownloadScheduler } from "./scheduler";
import {
    MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES,
    decodeDownloadTransfer,
    encodeDownloadTransfer,
} from "./transfer-format";
import { TransferItApiClient } from "./transfer-it-api-client";
import { indexZipFromSegments } from "./zip-index";

const CAT_CACHE_TTL_MS = 10 * 60 * 1000;
const KDX_FILTERS = [{ name: "Kiosk Download Transfer", extensions: ["kdx"] }];

export class DownloadService {
    private readonly api: KioApiClient;
    private readonly transferApi: TransferItApiClient;
    private readonly repository: DownloadRepository;
    private readonly metrics = new DownloadTransferMetrics();
    private readonly scheduler: DownloadScheduler;
    private readonly catCache = new Map<string, { cat: string; expiresAt: number }>();

    public constructor(private readonly kd: KioskDownloader) {
        this.api = new KioApiClient(kd);
        this.transferApi = new TransferItApiClient(kd);
        this.repository = new DownloadRepository(kd);
        this.scheduler = new DownloadScheduler(
            kd,
            this.api,
            this.transferApi,
            this.repository,
            this.metrics,
            async (id) => {
                await this.emitUpdate(id);
            },
            async (id, fileIds) => {
                await this.emitProgressUpdate(id, fileIds);
            },
        );
    }

    public registerStartupTasks() {
        this.kd.service.startupCleanup.register({
            name: "orphan-part-files",
            run: () => this.cleanupOrphanPartFiles(),
        });
    }

    public async restoreStartupState() {
        const mode = await this.kd.setting.transfer.getStartupResumeMode();
        this.repository.restoreStartupState(mode);
        this.repository.syncExpiredCollections();
        await this.emitUpdate();
        if (mode === "auto") {
            void this.scheduler.schedule();
        }
    }

    public hasActiveTransfers() {
        return this.scheduler.hasActiveTransfers();
    }

    public listOsProgressTransfers() {
        return this.repository.listOsProgressRows().map((row) =>
            toOsProgressTransfer({
                status: row.status,
                transferredBytes:
                    Number(row.transferredBytes) +
                    this.metrics.getCollectionSnapshot(row.id).activeTransferredBytes,
                totalBytes: Number(row.totalBytes),
            }),
        );
    }

    public destroy() {
        this.scheduler.destroy();
    }

    public async loadCollection(payload: LoadCollectionPayload) {
        try {
            const loaded = await this.loadCollectionUnlocked(payload);
            return loaded.collection;
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "download:loadCollection",
                    stage: "load",
                    url: payload.url,
                    message: toErrorMessage(error),
                },
                "DownloadService:loadCollection",
            );
            throw error;
        }
    }

    public async listZipEntries(payload: ListZipEntriesPayload): Promise<ListZipEntriesResult> {
        try {
            const loaded = await this.loadCollectionUnlocked(payload);
            if (loaded.provider === "transfer") {
                throw new Error("ZIP entry browsing is not supported for transfer.it.");
            }
            const found = findZipNodeById(loaded.collection.tree, payload.fileId);
            if (!found) {
                throw new Error(`ZIP file not found: ${payload.fileId}`);
            }
            const indexed = await this.indexZipNode(
                loaded,
                found.zip.id,
                found.zip.size,
                payload.zipPassword,
            );
            return { entries: indexed.entries };
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "download:listZipEntries",
                    stage: "index",
                    url: payload.url,
                    fileId: payload.fileId,
                    message: toErrorMessage(error),
                },
                "DownloadService:listZipEntries",
            );
            throw error;
        }
    }

    public async probeCollection(payload: ProbeCollectionPayload) {
        try {
            const parsed = tryParseDownloadUrl(payload.url);
            if (!parsed) {
                throw new Error("Invalid share URL.");
            }
            if (parsed.provider === "transfer") {
                return await this.transferApi.probeCollection(payload);
            }
            return await this.api.probeCollection(payload);
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "download:probeCollection",
                    stage: "probe",
                    url: payload.url,
                    message: toErrorMessage(error),
                },
                "DownloadService:probeCollection",
            );
            throw error;
        }
    }

    public async create(payload: CreateDownloadPayload) {
        const loaded = await this.loadCollectionUnlocked(payload);
        const selectedPaths = new Set(payload.selectedPaths);
        let tree = loaded.collection.tree;

        if (loaded.provider === "kiosk") {
            for (const { zip, path: zipPath } of listZipNodes(tree)) {
                if (!isZipExtractMode(zipPath, selectedPaths)) {
                    continue;
                }
                const zipPassword = payload.zipPasswords?.[zip.id];
                const indexed = await this.indexZipNode(loaded, zip.id, zip.size, zipPassword);
                tree = setZipEntries(tree, zip.id, indexed.entries);
            }
        }

        const enriched: LoadedCollection = {
            ...loaded,
            collection: {
                ...loaded.collection,
                tree,
            },
        };

        const basePath = payload.savePath.trim();
        const [createCollectionSubfolder, asciiFilenames] = await Promise.all([
            this.kd.setting.get("general.createCollectionSubfolder"),
            this.kd.setting.get("general.asciiFilenames"),
        ]);
        const savePath = shouldCreateCollectionSubfolder(
            enriched.collection.tree,
            enriched.collection.name,
            createCollectionSubfolder,
        )
            ? path.join(
                  basePath,
                  this.kd.lib.fs.sanitizeDownloadPathSegment(enriched.collection.name, {
                      asciiFilenames,
                      sanitizeString: " ",
                  }),
              )
            : basePath;
        const collectionId = this.repository.insertDownload({
            loaded: enriched,
            url: payload.url,
            password: enriched.passwordProtected ? payload.password : undefined,
            savePath,
            selectedPaths: payload.selectedPaths,
            asciiFilenames,
            zipPasswords: payload.zipPasswords,
        });
        await this.emitUpdate(collectionId);
        void this.scheduler.schedule();
        void this.kd.setting.set("general.lastDownloadPath", basePath);
        const item = this.repository.getItem(collectionId);
        return item ? this.enrichItem(item) : null;
    }

    private async loadCollectionUnlocked(payload: {
        url: string;
        password?: string;
    }): Promise<LoadedCollection> {
        const parsed = tryParseDownloadUrl(payload.url);
        if (!parsed) {
            throw new Error("Invalid share URL.");
        }
        if (parsed.provider === "transfer") {
            return this.transferApi.loadCollection(payload);
        }
        const loaded = await this.api.loadCollection(payload);
        this.cacheCat(loaded.collection.shareId, loaded.cat);
        return loaded;
    }

    private cacheCat(shareId: string, cat: string) {
        this.catCache.set(shareId, { cat, expiresAt: Date.now() + CAT_CACHE_TTL_MS });
    }

    private async getCat(loaded: LoadedKioskCollection) {
        const cached = this.catCache.get(loaded.collection.shareId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.cat;
        }
        this.cacheCat(loaded.collection.shareId, loaded.cat);
        return loaded.cat;
    }

    private async indexZipNode(
        loaded: LoadedKioskCollection,
        remoteFileId: string,
        fileSize: number,
        zipPassword?: string,
    ) {
        const cat = await this.getCat(loaded);
        const segments = await this.api.getSegments(remoteFileId, cat);
        return indexZipFromSegments({
            kd: this.kd,
            shareId: loaded.collection.shareId,
            remoteFileId,
            segments,
            segmentSize: loaded.collection.segmentSize,
            fileSize,
            zipPassword,
        });
    }

    public async list() {
        return this.repository.listItems().map((item) => this.enrichItem(item));
    }

    public async pauseCollection(collectionId: string) {
        this.scheduler.pauseCollection(collectionId);
        this.repository.pauseCollection(collectionId);
        await this.emitUpdate(collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
    }

    public async resumeCollection(collectionId: string, options: ResumePayload = {}) {
        if (this.repository.ensureCollectionNotExpired(collectionId)) {
            await this.emitUpdate(collectionId);
            return;
        }
        this.repository.resumeCollection(collectionId, Boolean(options.force));
        this.scheduler.resumeCollection(collectionId);
        await this.emitUpdate(collectionId);
    }

    public async pauseFile(_downloadId: string, fileId: string) {
        const file = this.repository.getFile(fileId);
        if (!file) {
            return null;
        }
        this.scheduler.pauseFile(fileId);
        this.repository.pauseFile(fileId);
        this.repository.recomputeCollectionStatus(file.collectionId);
        await this.emitUpdate(file.collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
        const item = this.repository.getItem(file.collectionId);
        return item ? this.enrichItem(item) : null;
    }

    public async resumeFile(downloadId: string, fileId: string, options: ResumePayload = {}) {
        const file = this.repository.getFile(fileId);
        if (!file) {
            return null;
        }
        if (this.repository.ensureCollectionNotExpired(file.collectionId)) {
            await this.emitUpdate(file.collectionId);
            const item = this.repository.getItem(file.collectionId);
            return item ? this.enrichItem(item) : null;
        }
        this.repository.resumeFile(fileId, Boolean(options.force));
        this.repository.markCollectionStatus(file.collectionId, "queued");
        this.scheduler.resumeFile(fileId);
        await this.emitUpdate(file.collectionId);
        const item = this.repository.getItem(file.collectionId);
        return item ? this.enrichItem(item) : null;
    }

    public async includeFile(downloadId: string, fileId: string) {
        const file = this.repository.getFile(fileId);
        if (!file) {
            return null;
        }
        if (this.repository.ensureCollectionNotExpired(file.collectionId)) {
            await this.emitUpdate(file.collectionId);
            const item = this.repository.getItem(file.collectionId);
            return item ? this.enrichItem(item) : null;
        }
        try {
            this.repository.includeFile(fileId);
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "download:includeFile",
                    stage: "include",
                    downloadId,
                    fileId,
                    filePath: file.path,
                    message: toErrorMessage(error),
                },
                "DownloadService:includeFile",
            );
            throw error;
        }
        this.repository.markCollectionStatus(file.collectionId, "queued");
        this.scheduler.resumeFile(fileId);
        await this.emitUpdate(file.collectionId);
        const item = this.repository.getItem(file.collectionId);
        return item ? this.enrichItem(item) : null;
    }

    public async includeFolder(downloadId: string, folderPath: string) {
        const collection = this.repository.getCollection(downloadId);
        if (!collection) {
            return null;
        }
        if (this.repository.ensureCollectionNotExpired(downloadId)) {
            await this.emitUpdate(downloadId);
            const item = this.repository.getItem(downloadId);
            return item ? this.enrichItem(item) : null;
        }

        let fileIds: string[] = [];
        try {
            fileIds = this.repository.includeFolder(downloadId, folderPath);
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "download:includeFolder",
                    stage: "include",
                    downloadId,
                    folderPath,
                    message: toErrorMessage(error),
                },
                "DownloadService:includeFolder",
            );
            throw error;
        }

        if (fileIds.length === 0) {
            const item = this.repository.getItem(downloadId);
            return item ? this.enrichItem(item) : null;
        }

        this.repository.markCollectionStatus(downloadId, "queued");
        for (const fileId of fileIds) {
            this.scheduler.resumeFile(fileId);
        }
        await this.emitUpdate(downloadId);
        const item = this.repository.getItem(downloadId);
        return item ? this.enrichItem(item) : null;
    }

    public async remove(collectionId: string) {
        const collection = this.repository.getCollection(collectionId);
        const files = collection ? this.repository.listFiles(collectionId) : [];
        this.scheduler.removeCollection(collectionId);
        this.repository.deleteCollection(collectionId);
        if (collection) {
            await this.scheduler.cleanupPartFiles(collection, files);
        }
        await this.emitUpdate();
        await this.kd.service.transfer.refreshPowerSaveBlock();
    }

    public async openFolder(collectionId: string) {
        const collection = this.repository.getCollection(collectionId);
        if (!collection) {
            throw new Error("Download item not found.");
        }
        await fse.ensureDir(collection.savePath);
        const result = await shell.openPath(collection.savePath);
        if (result) {
            throw new Error(result);
        }
    }

    public async exportCollection(collectionId: string) {
        const collection = this.repository.getCollection(collectionId);
        if (!collection) {
            throw new Error("Download item not found.");
        }

        let payload;
        try {
            payload = this.repository.buildTransferPayload(collectionId);
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "download:exportCollection",
                    stage: "build",
                    collectionId,
                    collectionName: collection.name,
                    message: toErrorMessage(error),
                },
                "DownloadService:exportCollection",
            );
            throw error;
        }

        const saveResult = await showSaveDialog({
            title: "컬렉션 내보내기",
            defaultPath: `${collection.name || "collection"}.kdx`,
            filters: KDX_FILTERS,
        });
        if (saveResult.canceled || !saveResult.filePath) {
            return null;
        }

        const filePath = saveResult.filePath.endsWith(".kdx")
            ? saveResult.filePath
            : `${saveResult.filePath}.kdx`;

        try {
            await fse.writeFile(filePath, encodeDownloadTransfer(payload));
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "download:exportCollection",
                    stage: "write",
                    collectionId,
                    collectionName: collection.name,
                    filePath,
                    message: toErrorMessage(error),
                },
                "DownloadService:exportCollection",
            );
            throw error;
        }

        return { filePath };
    }

    public async importCollection() {
        const openResult = await showOpenDialog({
            title: "컬렉션 가져오기",
            properties: ["openFile"],
            filters: KDX_FILTERS,
        });
        if (openResult.canceled || openResult.filePaths.length === 0) {
            return null;
        }
        const transferPath = openResult.filePaths[0];

        let payload;
        try {
            if ((await fse.stat(transferPath)).size > MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES) {
                throw new Error("Transfer file is too large.");
            }
            payload = decodeDownloadTransfer(await fse.readFile(transferPath));
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "download:importCollection",
                    stage: "decode",
                    transferPath,
                    message: toErrorMessage(error),
                },
                "DownloadService:importCollection",
            );
            throw error;
        }

        const lastDownloadPath = await this.kd.setting.get("general.lastDownloadPath");
        const folderResult = await showOpenDialog({
            title: "저장 폴더 선택",
            properties: ["openDirectory", "createDirectory"],
            defaultPath: lastDownloadPath || undefined,
        });
        if (folderResult.canceled || folderResult.filePaths.length === 0) {
            return null;
        }
        const basePath = folderResult.filePaths[0];

        const createCollectionSubfolder = await this.kd.setting.get(
            "general.createCollectionSubfolder",
        );
        const asciiFilenames = payload.collection.asciiFilenames;
        const savePath = shouldCreateCollectionSubfolder(
            payload.collection.tree,
            payload.collection.name,
            createCollectionSubfolder,
        )
            ? path.join(
                  basePath,
                  this.kd.lib.fs.sanitizeDownloadPathSegment(payload.collection.name, {
                      asciiFilenames,
                      sanitizeString: " ",
                  }),
              )
            : basePath;

        let collectionId: string;
        try {
            collectionId = this.repository.insertImportedDownload(payload, savePath);
            this.repository.ensureCollectionNotExpired(collectionId);
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "download:importCollection",
                    stage: "insert",
                    transferPath,
                    savePath,
                    collectionName: payload.collection.name,
                    shareId: payload.collection.shareId,
                    message: toErrorMessage(error),
                },
                "DownloadService:importCollection",
            );
            throw error;
        }

        await this.emitUpdate(collectionId);
        const imported = this.repository.getCollection(collectionId);
        if (imported?.status === "queued") {
            void this.scheduler.schedule();
        }
        void this.kd.setting.set("general.lastDownloadPath", basePath);
        const item = this.repository.getItem(collectionId);
        return item ? this.enrichItem(item) : null;
    }

    private async cleanupOrphanPartFiles() {
        const collections = this.kd.lib.db.all<DownloadCollectionRow>(
            `SELECT "id",
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
                    "ascii_filenames" AS "asciiFilenames"
             FROM "download_collection"`,
        );

        for (const collection of collections) {
            if (!(await fse.pathExists(collection.savePath))) {
                continue;
            }

            const expectedPartPaths = new Set(
                this.repository
                    .listFiles(collection.id)
                    .filter((file) => file.selected === 1 && file.status !== "completed")
                    .flatMap((file) => {
                        const partPath = this.getPartPath(collection, file);
                        return [partPath, getStagingPartPath(partPath)];
                    }),
            );

            const partFiles = await fg(["**/*.part", "**/*.part.z"], {
                cwd: collection.savePath,
                absolute: true,
                onlyFiles: true,
            });

            for (const partPath of partFiles) {
                if (expectedPartPaths.has(partPath)) {
                    continue;
                }

                await fse.remove(partPath).catch(() => undefined);
                await PartFileWriter.removeSidecar(partPath);
            }
        }
    }

    private getPartPath(collection: DownloadCollectionRow, file: DownloadFileRow) {
        return `${this.getFinalPath(collection, file)}.part`;
    }

    private getFinalPath(collection: DownloadCollectionRow, file: DownloadFileRow) {
        return path.join(
            collection.savePath,
            this.kd.lib.fs.getSafeRelativePath(file.path, {
                asciiFilenames: collection.asciiFilenames === 1,
            }),
        );
    }

    private enrichItem(item: DownloadItem, options: { sampleSpeeds?: boolean } = {}): DownloadItem {
        const progress: Record<string, FileProgress> = {};

        for (const [path, fileProgress] of Object.entries(item.progress)) {
            const snapshot =
                options.sampleSpeeds && fileProgress.status === "downloading"
                    ? this.metrics.sampleFile(fileProgress.fileId, fileProgress.downloaded)
                    : this.metrics.getFileSnapshot(fileProgress.fileId, fileProgress.downloaded);
            const liveDownloaded = Math.min(fileProgress.size, snapshot.liveDownloaded);
            const downloaded =
                fileProgress.status === "downloading" && fileProgress.size > 0
                    ? Math.min(liveDownloaded, Math.floor(fileProgress.size * 0.99))
                    : liveDownloaded;
            const speedBps =
                fileProgress.status === "downloading" &&
                liveDownloaded < fileProgress.size &&
                snapshot.speedBps > 0
                    ? snapshot.speedBps
                    : undefined;
            progress[path] = {
                ...fileProgress,
                downloaded,
                speedBps,
            };
        }

        const elapsedMs = this.scheduler.getCollectionElapsedMs(item.id);
        const collectionSpeedBps =
            item.status === "downloading" && options.sampleSpeeds
                ? this.metrics.sampleCollection(item.id)
                : this.metrics.getCollectionSnapshot(item.id).speedBps;
        if (item.status !== "downloading") {
            this.metrics.clearCollection(item.id);
        }

        return {
            ...item,
            progress,
            summary: {
                ...item.summary,
                transferredBytes: Math.min(
                    item.summary.totalBytes,
                    item.summary.transferredBytes +
                        this.metrics.getCollectionSnapshot(item.id).activeTransferredBytes,
                ),
            },
            speedBps:
                item.status === "downloading" && collectionSpeedBps > 0
                    ? collectionSpeedBps
                    : undefined,
            elapsedMs,
        };
    }

    private async emitProgressUpdate(collectionId: string, fileIds: Set<string>) {
        const collection = this.repository.getCollection(collectionId);
        if (!collection) {
            return;
        }

        const progress: Record<string, FileProgress> = {};
        for (const file of this.repository.getFilesByIds(collectionId, fileIds)) {
            const snapshot = this.metrics.sampleFile(file.id, file.downloadedBytes);
            const liveDownloaded = Math.min(file.size, snapshot.liveDownloaded);
            const downloaded =
                file.status === "downloading" && file.size > 0
                    ? Math.min(liveDownloaded, Math.floor(file.size * 0.99))
                    : liveDownloaded;
            progress[file.path] = {
                fileId: file.id,
                path: file.path,
                status: file.status,
                downloaded,
                size: file.size,
                selected: file.selected === 1,
                completedElsewhere: file.completedElsewhere === 1 ? true : undefined,
                speedBps:
                    file.status === "downloading" &&
                    liveDownloaded < file.size &&
                    snapshot.speedBps > 0
                        ? snapshot.speedBps
                        : undefined,
                error: file.error ?? undefined,
            };
        }

        const collectionSnapshot = this.metrics.getCollectionSnapshot(collectionId);
        const summary = this.repository.getSummary(collectionId);
        const patch: DownloadProgressPatch = {
            id: collectionId,
            progress,
            summary: {
                ...summary,
                transferredBytes: Math.min(
                    summary.totalBytes,
                    summary.transferredBytes + collectionSnapshot.activeTransferredBytes,
                ),
            },
            status: collection.status,
            speedBps:
                collection.status === "downloading"
                    ? this.metrics.sampleCollection(collectionId) || null
                    : null,
            elapsedMs: this.scheduler.getCollectionElapsedMs(collectionId),
            updatedAt: Date.parse(collection.updatedAt),
        };
        this.kd.ipc.sendToMainWindow("download:progress-update", patch);
        this.kd.service.transfer.syncMainWindowProgressBar();
    }

    private async emitUpdate(collectionId?: string, options: { sampleSpeeds?: boolean } = {}) {
        if (collectionId) {
            const item = this.repository.getItem(collectionId);
            if (item) {
                this.kd.ipc.sendToMainWindow(
                    "download:item-update",
                    this.enrichItem(item, options),
                );
            }
            this.kd.service.transfer.syncMainWindowProgressBar();
            return;
        }

        this.kd.ipc.sendToMainWindow(
            "download:update",
            this.repository.listItems().map((item) => this.enrichItem(item, options)),
        );
        this.kd.service.transfer.syncMainWindowProgressBar();
    }
}
