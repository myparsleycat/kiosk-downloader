import path from "node:path";

import { shouldCreateCollectionSubfolder } from "@shared/collection-path";
import type {
    CreateDownloadPayload,
    DownloadItem,
    FileProgress,
    LoadCollectionPayload,
    ProbeCollectionPayload,
    ResumePayload,
} from "@shared/types";
import { normalizePath, toErrorMessage } from "@shared/utils";
import { shell } from "electron";
import fg from "fast-glob";
import fse from "fs-extra";

import type { KioskDownloader } from "../..";
import type { DownloadCollectionRow, DownloadFileRow } from "./types";

import { KioApiClient } from "./kio-api-client";
import { DownloadTransferMetrics } from "./metrics";
import { PartFileWriter } from "./part-file";
import { DownloadRepository } from "./repository";
import { DownloadScheduler } from "./scheduler";

export class DownloadService {
    private readonly api: KioApiClient;
    private readonly repository: DownloadRepository;
    private readonly metrics = new DownloadTransferMetrics();
    private readonly scheduler: DownloadScheduler;

    public constructor(private readonly kd: KioskDownloader) {
        this.api = new KioApiClient(kd);
        this.repository = new DownloadRepository(kd);
        this.scheduler = new DownloadScheduler(
            kd,
            this.api,
            this.repository,
            this.metrics,
            async (id) => {
                await this.emitUpdate(id);
            },
            async (id) => {
                await this.emitUpdate(id, { sampleSpeeds: true });
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

    public destroy() {
        this.scheduler.destroy();
    }

    public async loadCollection(payload: LoadCollectionPayload) {
        try {
            return (await this.api.loadCollection(payload)).collection;
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

    public async probeCollection(payload: ProbeCollectionPayload) {
        try {
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
        const loaded = await this.api.loadCollection(payload);
        const basePath = payload.savePath.trim();
        const createCollectionSubfolder = await this.kd.setting.get(
            "general.createCollectionSubfolder",
        );
        const savePath = shouldCreateCollectionSubfolder(
            loaded.collection.tree,
            loaded.collection.name,
            createCollectionSubfolder,
        )
            ? path.join(basePath, this.kd.lib.fs.sanitizeWindowsFilename(loaded.collection.name))
            : basePath;
        const collectionId = this.repository.insertDownload({
            loaded,
            url: payload.url,
            password: loaded.passwordProtected ? payload.password : undefined,
            savePath,
            selectedPaths: payload.selectedPaths,
        });
        await this.emitUpdate(collectionId);
        void this.scheduler.schedule();
        void this.kd.setting.set("general.lastDownloadPath", basePath);
        const item = this.repository.getItem(collectionId);
        return item ? this.enrichItem(item) : null;
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
                    "error"
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
                    .map((file) => this.getPartPath(collection, file)),
            );

            const partFiles = await fg("**/*.part", {
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
        return path.join(collection.savePath, this.getSafeRelativePath(file.path));
    }

    private getSafeRelativePath(input: string) {
        return normalizePath(input)
            .split("/")
            .filter(Boolean)
            .map((part) => this.kd.lib.fs.sanitizeWindowsFilename(part, "_"))
            .join(path.sep);
    }

    private enrichItem(item: DownloadItem, options: { sampleSpeeds?: boolean } = {}): DownloadItem {
        const progress: Record<string, FileProgress> = {};

        for (const [path, fileProgress] of Object.entries(item.progress)) {
            const snapshot =
                options.sampleSpeeds && fileProgress.status === "downloading"
                    ? this.metrics.sampleFile(fileProgress.fileId, fileProgress.downloaded)
                    : this.metrics.getFileSnapshot(fileProgress.fileId, fileProgress.downloaded);
            const liveDownloaded = Math.min(fileProgress.size, snapshot.liveDownloaded);
            const speedBps =
                fileProgress.status === "downloading" && snapshot.speedBps > 0
                    ? snapshot.speedBps
                    : undefined;
            progress[path] = {
                ...fileProgress,
                downloaded: liveDownloaded,
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
            speedBps:
                item.status === "downloading" && collectionSpeedBps > 0
                    ? collectionSpeedBps
                    : undefined,
            elapsedMs,
        };
    }

    private async emitUpdate(collectionId?: string, options: { sampleSpeeds?: boolean } = {}) {
        if (collectionId) {
            const item = this.repository.getItem(collectionId);
            if (item) {
                this.kd.ipc.broadcast("download:item-update", this.enrichItem(item, options));
            }
            return;
        }

        this.kd.ipc.broadcast(
            "download:update",
            this.repository.listItems().map((item) => this.enrichItem(item, options)),
        );
    }
}
