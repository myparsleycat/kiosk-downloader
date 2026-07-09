import type {
    CreateUploadPayload,
    DirNode,
    FileNode,
    UploadFileProgress,
    UploadItem,
} from "@shared/types";
import { toErrorMessage } from "@shared/utils";
import { clipboard } from "electron";

import type { KioskDownloader } from "../..";
import type { ServerFileMapping } from "./types";

import { KioUploadClient } from "./kio-upload-client";
import { UploadTransferMetrics } from "./metrics";
import { UploadRepository } from "./repository";
import { UploadScheduler } from "./scheduler";
import { TurnstileSolver } from "./turnstile";

function buildDisplayTree(files: { path: string; name: string; size: number }[]): DirNode {
    const root: DirNode = {
        type: "dir",
        id: "root",
        name: "",
        entries: [],
    };

    type MutableDir = DirNode;
    const dirsByPath = new Map<string, MutableDir>();
    dirsByPath.set("", root);

    const ensureDir = (segments: string[]): MutableDir => {
        const dirPath = segments.join("/");
        const existing = dirsByPath.get(dirPath);
        if (existing) {
            return existing;
        }

        const parent = ensureDir(segments.slice(0, -1));
        const dir: MutableDir = {
            type: "dir",
            id: dirPath,
            name: segments[segments.length - 1],
            entries: [],
        };
        dirsByPath.set(dirPath, dir);
        parent.entries.push({ kind: "dir", node: dir });
        return dir;
    };

    for (const file of files) {
        const segments = file.path.split("/").filter(Boolean);
        const dir = ensureDir(segments.slice(0, -1));
        const node: FileNode = {
            type: "file",
            id: file.path,
            name: segments[segments.length - 1] ?? file.name,
            size: file.size,
        };
        dir.entries.push({ kind: "file", node });
    }

    return root;
}

export class UploadService {
    private readonly api: KioUploadClient;
    private readonly repository: UploadRepository;
    private readonly metrics = new UploadTransferMetrics();
    private readonly turnstile: TurnstileSolver;
    private readonly scheduler: UploadScheduler;

    public constructor(private readonly kd: KioskDownloader) {
        this.api = new KioUploadClient(kd);
        this.repository = new UploadRepository(kd);
        this.turnstile = new TurnstileSolver(kd);
        this.scheduler = new UploadScheduler(
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

    public async solveTurnstile(): Promise<string> {
        try {
            const parentWindow = this.kd.window.main.window;
            return await this.turnstile.solve(parentWindow);
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "upload:solveTurnstile",
                    stage: "turnstile",
                    message: toErrorMessage(error),
                },
                "UploadService:solveTurnstile",
            );
            throw error;
        }
    }

    public async create(payload: CreateUploadPayload): Promise<UploadItem | null> {
        try {
            const tree = buildDisplayTree(payload.tree);

            const created = await this.api.createCollection(
                payload.tree,
                payload.options,
                payload.turnstileToken,
            );

            const collectionId = this.repository.insertUpload({
                created,
                options: payload.options,
                files: payload.tree.map((file) => ({
                    path: file.path,
                    name: file.name,
                    size: file.size,
                    fsPath: file.fsPath,
                })),
                tree,
            });

            this.backfillRemoteIds(collectionId, created.workItems);

            const fileRows = this.repository.listFiles(collectionId);
            this.scheduler.registerWorkItems(
                collectionId,
                fileRows.map((file) => ({ id: file.id, remoteId: file.remoteId })),
                created.workItems,
                created.uploadToken,
            );

            await this.emitUpdate(collectionId);
            void this.scheduler.schedule();

            const item = this.repository.getItem(collectionId);
            return item ? this.enrichItem(item) : null;
        } catch (error) {
            this.kd.logger.error(
                {
                    channel: "upload:create",
                    stage: "create",
                    fileCount: payload.tree.length,
                    name: payload.options.name,
                    message: toErrorMessage(error),
                },
                "UploadService:create",
            );
            throw error;
        }
    }

    public async list(): Promise<UploadItem[]> {
        return this.repository.listItems().map((item) => this.enrichItem(item));
    }

    public async pauseUpload(collectionId: string) {
        this.scheduler.pauseCollection(collectionId);
        this.repository.pauseCollection(collectionId);
        await this.emitUpdate(collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
    }

    public async resumeUpload(collectionId: string, options: { force?: boolean } = {}) {
        this.repository.resumeCollection(collectionId, Boolean(options.force));
        this.scheduler.resumeCollection(collectionId);
        await this.emitUpdate(collectionId);
    }

    public async remove(collectionId: string) {
        this.scheduler.removeCollection(collectionId);
        this.repository.deleteCollection(collectionId);
        await this.emitUpdate();
        await this.kd.service.transfer.refreshPowerSaveBlock();
    }

    public async copyLink(collectionId: string) {
        const collection = this.repository.getCollection(collectionId);
        if (!collection?.shareLink) {
            throw new Error("공유 링크가 아직 생성되지 않았습니다.");
        }
        clipboard.writeText(collection.shareLink);
    }

    public hasActiveTransfers() {
        return this.scheduler.hasActiveTransfers();
    }

    public async restoreStartupState() {
        // Conservative: reset any 'uploading' rows to 'queued' but do NOT
        // auto-resume. The upload token (UT) minted at collection/create may
        // have expired server-side during downtime, so resuming blindly would
        // fail mid-stream. The user explicitly retries, which surfaces a clear
        // error if the UT is stale.
        this.repository.restoreStartupState("manual");
        await this.emitUpdate();
    }

    public destroy() {
        this.scheduler.destroy();
        this.turnstile.destroy();
    }

    private backfillRemoteIds(collectionId: string, workItems: ServerFileMapping[]) {
        // workItems carry the server file id and fsPath; match DB file rows by fsPath.
        const files = this.repository.listFiles(collectionId);
        const remoteByFsPath = new Map<string, string>();
        for (const item of workItems) {
            if (!remoteByFsPath.has(item.fsPath)) {
                remoteByFsPath.set(item.fsPath, item.fileId.toString("hex"));
            }
        }
        for (const file of files) {
            const remoteId = remoteByFsPath.get(file.fsPath);
            if (remoteId) {
                this.repository.setFileRemoteId(file.id, remoteId);
            }
        }
    }

    private enrichItem(item: UploadItem, options: { sampleSpeeds?: boolean } = {}): UploadItem {
        const progress: Record<string, UploadFileProgress> = {};

        for (const [path, fileProgress] of Object.entries(item.progress)) {
            const snapshot =
                options.sampleSpeeds && fileProgress.status === "uploading"
                    ? this.metrics.sampleFile(fileProgress.fileId)
                    : this.metrics.getFileSnapshot(fileProgress.fileId);

            const speedBps =
                fileProgress.status === "uploading" && snapshot.speedBps > 0
                    ? snapshot.speedBps
                    : undefined;

            progress[path] = {
                ...fileProgress,
                speedBps,
            };
        }

        const elapsedMs = this.scheduler.getCollectionElapsedMs(item.id);
        const collectionSpeedBps =
            item.status === "uploading" && options.sampleSpeeds
                ? this.metrics.sampleCollection(item.id)
                : this.metrics.getCollectionSnapshot(item.id).speedBps;
        if (item.status !== "uploading") {
            this.metrics.clearCollection(item.id);
        }

        return {
            ...item,
            progress,
            speedBps:
                item.status === "uploading" && collectionSpeedBps > 0
                    ? collectionSpeedBps
                    : undefined,
            elapsedMs,
        };
    }

    private async emitUpdate(collectionId?: string, options: { sampleSpeeds?: boolean } = {}) {
        if (collectionId) {
            const item = this.repository.getItem(collectionId);
            if (item) {
                this.kd.ipc.broadcast("upload:item-update", this.enrichItem(item, options));
            }
            return;
        }

        this.kd.ipc.broadcast(
            "upload:update",
            this.repository.listItems().map((item) => this.enrichItem(item, options)),
        );
    }
}
