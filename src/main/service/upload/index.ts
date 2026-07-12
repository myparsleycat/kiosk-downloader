import path from "node:path";
import type { Readable } from "node:stream";

import { buildDirTreeFromFiles } from "@shared/dir-tree";
import { validateRenameName } from "@shared/name-validation";
import type {
    CreateUploadPayload,
    ExpandPathsResult,
    UploadFileProgress,
    UploadItem,
    UploadProgressPatch,
    UploadTreeFile,
} from "@shared/types";
import { MAX_UPLOAD_FILES } from "@shared/types";
import { normalizePath } from "@shared/utils";
import { clipboard } from "electron";
import fg from "fast-glob";
import type { Entry } from "fast-glob";
import fse from "fs-extra";

import type { KioskDownloader } from "../..";
import type { ServerFileMapping, UploadSourceFile } from "./types";

import { withLoggedError } from "../../lib/logged-error";
import { toOsProgressTransfer } from "../os-progress-bar";
import { KioUploadClient } from "./kio-upload-client";
import { UploadTransferMetrics } from "./metrics";
import { UploadRepository } from "./repository";
import { UploadScheduler } from "./scheduler";
import { TurnstileSolver } from "./turnstile";
import { UPLOAD_SEGMENT_SIZE } from "./types";

function toDisplayFile(file: UploadSourceFile): UploadTreeFile {
    return {
        path: file.path,
        name: file.name,
        size: file.size,
        sourceMtimeMs: file.sourceMtimeMs,
    };
}

export class UploadService {
    private readonly api: KioUploadClient;
    private readonly repository: UploadRepository;
    private readonly metrics = new UploadTransferMetrics();
    private readonly turnstile: TurnstileSolver;
    private readonly scheduler: UploadScheduler;
    /** Absolute paths for the in-progress new-upload draft. Never sent to the renderer. */
    private readonly draftSources = new Map<string, UploadSourceFile>();

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
            async (id, fileIds) => {
                await this.emitProgressUpdate(id, fileIds);
            },
        );
    }

    public async solveTurnstile(): Promise<string> {
        return withLoggedError(
            this.kd.logger,
            "UploadService:solveTurnstile",
            {
                channel: "upload:solveTurnstile",
                stage: "turnstile",
            },
            async () => {
                const parentWindow = this.kd.window.main.window;
                return await this.turnstile.solve(parentWindow);
            },
        );
    }

    public async expandPaths(
        inputs: string[],
        maxFiles: number = MAX_UPLOAD_FILES,
    ): Promise<ExpandPathsResult> {
        const limit = Math.max(0, Math.min(maxFiles, MAX_UPLOAD_FILES));
        if (limit === 0) return { files: [], truncated: true };

        const { sources, truncated } = await collectUploadSources(inputs, limit);
        for (const source of sources) {
            this.draftSources.set(source.path, source);
        }
        return { files: sources.map(toDisplayFile), truncated };
    }

    public clearDraftSources() {
        this.draftSources.clear();
    }

    public removeDraftSources(paths: string[]) {
        for (const treePath of paths) {
            const prefix = `${treePath}/`;
            for (const key of [...this.draftSources.keys()]) {
                if (key === treePath || key.startsWith(prefix)) {
                    this.draftSources.delete(key);
                }
            }
        }
    }

    public renameDraftSource(oldPath: string, newPath: string) {
        const slashIndex = oldPath.lastIndexOf("/");
        const newName = slashIndex === -1 ? newPath : newPath.slice(slashIndex + 1);
        const nameError = validateRenameName(newName);
        if (nameError) {
            throw new Error(nameError);
        }

        const prefix = `${oldPath}/`;
        const keysToMove: string[] = [];
        for (const key of this.draftSources.keys()) {
            if (key === oldPath || key.startsWith(prefix)) {
                keysToMove.push(key);
            }
        }

        for (const key of keysToMove) {
            const source = this.draftSources.get(key);
            if (!source) continue;
            const childPath = key === oldPath ? newPath : `${newPath}${key.slice(oldPath.length)}`;
            this.draftSources.delete(key);
            this.draftSources.set(childPath, {
                ...source,
                path: childPath,
                name: childPath.includes("/")
                    ? childPath.slice(childPath.lastIndexOf("/") + 1)
                    : childPath,
            });
        }
    }

    public async create(payload: CreateUploadPayload): Promise<UploadItem | null> {
        return withLoggedError(
            this.kd.logger,
            "UploadService:create",
            {
                channel: "upload:create",
                stage: "create",
                fileCount: payload.tree.length,
                name: payload.options.name,
            },
            async () => {
                const files = await this.resolveCreateFiles(payload.tree);
                const tree = buildDirTreeFromFiles(files);

                const created = await this.api.createCollection(
                    files,
                    payload.options,
                    payload.turnstileToken,
                );

                const collectionId = this.repository.insertUpload({
                    created,
                    options: payload.options,
                    files: files.map((file) => ({
                        path: file.path,
                        name: file.name,
                        size: file.size,
                        fsPath: file.fsPath,
                        sourceMtimeMs: file.sourceMtimeMs,
                    })),
                    segmentSize: UPLOAD_SEGMENT_SIZE,
                    tree,
                });

                this.backfillRemoteIds(collectionId, created.workItems);
                this.clearDraftSources();

                const fileRows = this.repository.listFiles(collectionId);
                this.scheduler.registerWorkItems(
                    collectionId,
                    fileRows.map((file) => ({ id: file.id, remoteId: file.remoteId })),
                    created.workItems,
                );

                await this.emitUpdate(collectionId);
                void this.scheduler.schedule();

                const item = this.repository.getItem(collectionId);
                return item ? this.enrichItem(item) : null;
            },
        );
    }

    public async list(): Promise<UploadItem[]> {
        return this.repository.listItems().map((item) => this.enrichItem(item));
    }

    public async pauseUpload(collectionId: string) {
        await this.scheduler.pauseCollection(collectionId);
        this.repository.pauseCollection(collectionId);
        await this.emitUpdate(collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
    }

    public async resumeUpload(collectionId: string, options: { force?: boolean } = {}) {
        this.repository.resumeCollection(collectionId, Boolean(options.force));
        await this.scheduler.resumeCollection(collectionId);
        await this.emitUpdate(collectionId);
    }

    public async pauseFile(collectionId: string, fileId: string) {
        const file = this.repository.getFile(fileId);
        if (!file || file.collectionId !== collectionId) {
            return null;
        }
        await this.scheduler.pauseFile(fileId);
        this.repository.pauseFile(fileId);
        this.repository.recomputeCollectionStatus(collectionId);
        await this.emitUpdate(collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
        const item = this.repository.getItem(collectionId);
        return item ? this.enrichItem(item) : null;
    }

    public async resumeFile(
        collectionId: string,
        fileId: string,
        _options: { force?: boolean } = {},
    ) {
        const file = this.repository.getFile(fileId);
        if (!file || file.collectionId !== collectionId) {
            return null;
        }
        const collection = this.repository.getCollection(collectionId);
        if (collection?.status === "error") {
            this.repository.resumeCollection(collectionId, true);
            await this.scheduler.resumeCollection(collectionId);
            await this.emitUpdate(collectionId);
            const item = this.repository.getItem(collectionId);
            return item ? this.enrichItem(item) : null;
        }
        this.repository.resumeFile(fileId);
        this.repository.markCollectionStatus(collectionId, "queued");
        await this.scheduler.resumeFile(fileId);
        await this.emitUpdate(collectionId);
        const item = this.repository.getItem(collectionId);
        return item ? this.enrichItem(item) : null;
    }

    public async remove(collectionId: string) {
        await this.scheduler.removeCollection(collectionId);
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

    public async restoreStartupState() {
        const mode = await this.kd.setting.get("transfer.uploadStartupResumeMode");
        this.repository.restoreStartupState(mode);
        await this.scheduler.restoreFromRepository();
        await this.emitUpdate();
        if (mode === "auto") {
            await this.scheduler.schedule();
        }
    }

    public destroy() {
        this.scheduler.destroy();
        this.turnstile.destroy();
        this.clearDraftSources();
    }

    private async resolveCreateFiles(
        files: CreateUploadPayload["tree"],
    ): Promise<UploadSourceFile[]> {
        const seenPaths = new Set<string>();
        const resolved: UploadSourceFile[] = [];

        for (const file of files) {
            const normalizedPath = file.path.split("/").filter(Boolean).join("/");
            if (!normalizedPath || seenPaths.has(normalizedPath)) {
                throw new Error(`업로드 경로가 비어 있거나 중복됩니다: ${file.path}`);
            }
            seenPaths.add(normalizedPath);

            const source = this.draftSources.get(normalizedPath);
            if (!source) {
                throw new Error(`업로드 원본 경로를 찾을 수 없습니다: ${normalizedPath}`);
            }

            const stat = await fse.stat(source.fsPath).catch(() => null);
            if (
                !stat?.isFile() ||
                stat.size !== file.size ||
                Math.trunc(stat.mtimeMs) !== file.sourceMtimeMs
            ) {
                throw new Error(
                    `업로드 원본 파일이 변경되었거나 읽을 수 없습니다: ${source.fsPath}`,
                );
            }

            resolved.push({
                ...source,
                path: normalizedPath,
                size: file.size,
                sourceMtimeMs: file.sourceMtimeMs,
            });
        }

        return resolved;
    }

    private backfillRemoteIds(collectionId: string, workItems: ServerFileMapping[]) {
        const files = this.repository.listFiles(collectionId);
        const remoteByPath = new Map<string, string>();
        for (const item of workItems) {
            const remoteId = item.fileId.toString("hex");
            const existing = remoteByPath.get(item.relativePath);
            if (existing && existing !== remoteId) {
                throw new Error(`서버 파일 ID 매핑이 일관되지 않습니다: ${item.relativePath}`);
            }
            remoteByPath.set(item.relativePath, remoteId);
        }
        for (const file of files) {
            const remoteId = remoteByPath.get(file.path);
            if (!remoteId) {
                throw new Error(`서버 파일 ID 매핑이 없습니다: ${file.path}`);
            }
            this.repository.setFileRemoteId(file.id, remoteId);
        }
    }

    private enrichItem(item: UploadItem, options: { sampleSpeeds?: boolean } = {}): UploadItem {
        const progress: Record<string, UploadFileProgress> = {};

        for (const [pathKey, fileProgress] of Object.entries(item.progress)) {
            const snapshot =
                options.sampleSpeeds && fileProgress.status === "uploading"
                    ? this.metrics.sampleFile(fileProgress.fileId, fileProgress.uploaded)
                    : this.metrics.getFileSnapshot(fileProgress.fileId, fileProgress.uploaded);

            const speedBps =
                fileProgress.status === "uploading" && snapshot.speedBps > 0
                    ? snapshot.speedBps
                    : undefined;
            const uploaded = Math.min(
                fileProgress.size,
                Math.max(fileProgress.uploaded, snapshot.uploaded),
            );

            progress[pathKey] = {
                ...fileProgress,
                uploaded,
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
            summary: {
                ...item.summary,
                transferredBytes: Math.min(
                    item.summary.totalBytes,
                    item.summary.transferredBytes +
                        this.metrics.getCollectionSnapshot(item.id).activeTransferredBytes,
                ),
            },
            speedBps:
                item.status === "uploading" && collectionSpeedBps > 0
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

        const progress: Record<string, UploadFileProgress> = {};
        for (const file of this.repository.listFilesByIds(collectionId, fileIds)) {
            const snapshot = this.metrics.sampleFile(file.id, file.uploadedBytes);
            progress[file.path] = {
                fileId: file.id,
                path: file.path,
                status: file.status,
                uploaded: Math.min(file.size, snapshot.uploaded),
                size: file.size,
                speedBps:
                    file.status === "uploading" && snapshot.speedBps > 0
                        ? snapshot.speedBps
                        : undefined,
                error: file.error ?? undefined,
            };
        }

        const collectionSnapshot = this.metrics.getCollectionSnapshot(collectionId);
        const summary = this.repository.getProgressSummary(collectionId);
        const patch: UploadProgressPatch = {
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
                collection.status === "uploading"
                    ? this.metrics.sampleCollection(collectionId) || null
                    : null,
            elapsedMs: this.scheduler.getCollectionElapsedMs(collectionId),
            updatedAt: Date.parse(collection.updatedAt),
        };
        this.kd.ipc.sendToMainWindow("upload:progress-update", patch);
        this.kd.service.transfer.syncMainWindowProgressBar();
    }

    private async emitUpdate(collectionId?: string, options: { sampleSpeeds?: boolean } = {}) {
        if (collectionId) {
            const item = this.repository.getItem(collectionId);
            if (item) {
                this.kd.ipc.sendToMainWindow("upload:item-update", this.enrichItem(item, options));
            }
            this.kd.service.transfer.syncMainWindowProgressBar();
            return;
        }

        this.kd.ipc.sendToMainWindow(
            "upload:update",
            this.repository.listItems().map((item) => this.enrichItem(item, options)),
        );
        this.kd.service.transfer.syncMainWindowProgressBar();
    }
}

async function collectUploadSources(
    inputs: string[],
    maxFiles: number,
): Promise<{ sources: UploadSourceFile[]; truncated: boolean }> {
    const out: UploadSourceFile[] = [];
    const seen = new Set<string>();
    let truncated = false;

    for (const input of inputs) {
        if (out.length >= maxFiles) {
            truncated = true;
            break;
        }

        const stat = await fse.stat(input);
        if (stat.isFile()) {
            const treePath = path.basename(input);
            assertUniqueTreePath(seen, treePath);
            out.push({
                path: treePath,
                name: treePath,
                size: stat.size,
                fsPath: input,
                sourceMtimeMs: Math.trunc(stat.mtimeMs),
            });
            continue;
        }

        const rootName = path.basename(input);
        const stream = fg.stream("**/*", {
            cwd: input,
            onlyFiles: true,
            dot: true,
            absolute: true,
            stats: true,
            followSymbolicLinks: false,
        }) as Readable;

        try {
            for await (const raw of stream) {
                if (out.length >= maxFiles) {
                    truncated = true;
                    break;
                }
                const entry = raw as Entry;
                const relative = path.relative(input, entry.path);
                const treePath = normalizePath(`${rootName}/${relative}`);
                assertUniqueTreePath(seen, treePath);
                out.push({
                    path: treePath,
                    name: path.basename(entry.path),
                    size: entry.stats?.size ?? 0,
                    fsPath: entry.path,
                    sourceMtimeMs: Math.trunc(entry.stats?.mtimeMs ?? 0),
                });
            }
        } finally {
            stream.destroy();
        }
    }

    return { sources: out, truncated };
}

function assertUniqueTreePath(seen: Set<string>, treePath: string) {
    if (seen.has(treePath)) {
        throw new Error(`같은 업로드 경로에 두 파일을 추가할 수 없습니다: ${treePath}`);
    }
    seen.add(treePath);
}
