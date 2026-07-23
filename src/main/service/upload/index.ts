import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";

import { formatCompatShareText } from "@shared/compat-share-text";
import { buildDirTreeFromFiles } from "@shared/dir-tree";
import {
    createExtendedUploadPlan,
    EXTENDED_UPLOAD_DEFAULT_LIMITS,
    type ExtendedUploadMode,
} from "@shared/extended-upload-plan";
import type {
    CreateUploadPayload,
    ExpandPathsResult,
    UploadFileProgress,
    UploadItem,
    UploadProgressPatch,
    UploadTreeFile,
} from "@shared/types";
import { normalizePath } from "@shared/utils";
import { app, clipboard, Notification } from "electron";
import fg from "fast-glob";
import type { Entry } from "fast-glob";
import fse from "fs-extra";

import type { KioskDownloader } from "../..";
import type { ServerFileMapping, UploadBundleRow, UploadSourceFile } from "./types";

import { withLoggedError } from "../../lib/logged-error";
import {
    encodeExtendedShare,
    encodeExtendedShareFile,
    type ExtendedShareSplitFile,
} from "../extended-share";
import { toOsProgressTransfer } from "../os-progress-bar";
import { showSaveDialog } from "../util";
import { KioUploadClient } from "./kio-upload-client";
import { UploadTransferMetrics } from "./metrics";
import { pieceToPersistedFile } from "./preparation-core";
import { PreparationWorkerClient } from "./preparation-worker-client";
import { UploadRepository } from "./repository";
import { UploadScheduler } from "./scheduler";
import { type PersistedBundlePlan } from "./small-file-pack";
import { TurnstileSolver } from "./turnstile";
import { UPLOAD_SEGMENT_SIZE } from "./types";
import { isKioskCompatiblePath } from "./upload-path";

const KDS_FILTERS = [{ name: "Kiosk Extended Share", extensions: ["kds"] }];
const COMPAT_SHARE_FILTERS = [{ name: "Text", extensions: ["txt"] }];

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
    private readonly preparationWorker: PreparationWorkerClient;
    private readonly notifiedFailures = new Set<string>();
    private readonly bundleInitializations = new Map<string, Promise<unknown>>();
    /** Absolute paths for the in-progress new-upload draft. Never sent to the renderer. */
    private readonly draftSources = new Map<string, UploadSourceFile>();
    private readonly pendingBundleProgress = new Map<string, Set<string>>();
    private bundleProgressFlushTimer: ReturnType<typeof setTimeout> | null = null;

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
                if (id) await this.handleCollectionUpdate(id);
                else await this.emitUpdate();
            },
            async (id, fileIds) => {
                await this.emitProgressUpdate(id, fileIds);
            },
        );
        this.preparationWorker = new PreparationWorkerClient(kd.logger);
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
        maxFiles: number = Number.MAX_SAFE_INTEGER,
    ): Promise<ExpandPathsResult> {
        const limit = Math.max(0, Math.min(maxFiles, Number.MAX_SAFE_INTEGER));
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

    public renameDraftSources(from: string, to: string) {
        if (from === to) {
            return;
        }
        const prefix = `${from}/`;
        const next = new Map<string, UploadSourceFile>();
        for (const [key, source] of this.draftSources) {
            if (key === from) {
                const name = to.includes("/") ? to.slice(to.lastIndexOf("/") + 1) : to;
                next.set(to, { ...source, path: to, name });
                continue;
            }
            if (key.startsWith(prefix)) {
                const nextPath = `${to}/${key.slice(prefix.length)}`;
                const name = nextPath.includes("/")
                    ? nextPath.slice(nextPath.lastIndexOf("/") + 1)
                    : nextPath;
                next.set(nextPath, { ...source, path: nextPath, name });
                continue;
            }
            next.set(key, source);
        }
        if (next.size !== this.draftSources.size) {
            throw new Error("같은 위치에 동일한 이름의 파일이 이미 존재합니다.");
        }
        this.draftSources.clear();
        for (const [key, source] of next) {
            this.draftSources.set(key, source);
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
                if (payload.mode === "integrated" || payload.mode === "compatible") {
                    return await this.createBundle(payload, payload.mode);
                }
                const files = await this.sanitizeCreateFiles(
                    await this.resolveCreateFiles(payload.tree),
                );
                if (
                    files.length > EXTENDED_UPLOAD_DEFAULT_LIMITS.maxFiles ||
                    files.reduce((sum, file) => sum + file.size, 0) >
                        EXTENDED_UPLOAD_DEFAULT_LIMITS.maxBytes
                ) {
                    throw new Error("이 파일 선택에는 확장 업로드 모드가 필요합니다.");
                }
                const tree = buildDirTreeFromFiles(files);

                const created = await this.api.createCollection(
                    files,
                    payload.options,
                    payload.turnstileToken ?? (await this.solveTurnstile()),
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
        const bundle = this.repository.getBundle(collectionId);
        if (bundle) {
            for (const collection of this.repository.listBundleCollections(bundle.id)) {
                if (collection.status === "completed") continue;
                await this.scheduler.pauseCollection(collection.id);
                this.repository.pauseCollection(collection.id);
            }
            this.repository.markBundleStatus(bundle.id, "paused");
            await this.emitUpdate(bundle.id);
            await this.kd.service.transfer.refreshPowerSaveBlock();
            return;
        }
        await this.scheduler.pauseCollection(collectionId);
        this.repository.pauseCollection(collectionId);
        await this.emitUpdate(collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
    }

    public async resumeUpload(collectionId: string, options: { force?: boolean } = {}) {
        const bundle = this.repository.getBundle(collectionId);
        if (bundle) {
            if (bundle.initializedCount < bundle.physicalCount) {
                await this.initializeBundle(bundle);
                return;
            }
            for (const collection of this.repository.listBundleCollections(bundle.id)) {
                if (collection.status !== "paused") continue;
                this.repository.resumeCollection(collection.id, Boolean(options.force));
                await this.scheduler.resumeCollection(collection.id);
            }
            this.repository.queueBundle(bundle.id);
            await this.emitUpdate(bundle.id);
            return;
        }
        this.repository.resumeCollection(collectionId, Boolean(options.force));
        await this.scheduler.resumeCollection(collectionId);
        await this.emitUpdate(collectionId);
    }

    public async pauseFile(collectionId: string, fileId: string) {
        const bundle = this.repository.getBundle(collectionId);
        const physicalFileId = fileId.split("::pack::", 1)[0];
        const file = this.repository.getFile(physicalFileId);
        if (!file || (!bundle && file.collectionId !== collectionId)) {
            return null;
        }
        await this.scheduler.pauseFile(file.id);
        this.repository.pauseFile(file.id);
        this.repository.recomputeCollectionStatus(file.collectionId);
        await this.emitUpdate(bundle?.id ?? collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
        const item = this.repository.getItem(bundle?.id ?? collectionId);
        return item ? this.enrichItem(item) : null;
    }

    public async resumeFile(
        collectionId: string,
        fileId: string,
        _options: { force?: boolean } = {},
    ) {
        const bundle = this.repository.getBundle(collectionId);
        const physicalFileId = fileId.split("::pack::", 1)[0];
        const file = this.repository.getFile(physicalFileId);
        if (!file || (!bundle && file.collectionId !== collectionId)) {
            return null;
        }
        const collection = this.repository.getCollection(file.collectionId);
        if (collection?.status === "error") {
            this.repository.resumeCollection(file.collectionId, true);
            await this.scheduler.resumeCollection(file.collectionId);
            if (bundle) this.repository.queueBundle(bundle.id);
            await this.emitUpdate(bundle?.id ?? collectionId);
            const item = this.repository.getItem(bundle?.id ?? collectionId);
            return item ? this.enrichItem(item) : null;
        }
        this.repository.resumeFile(file.id);
        this.repository.markCollectionStatus(file.collectionId, "queued");
        await this.scheduler.resumeFile(file.id);
        if (bundle) this.repository.queueBundle(bundle.id);
        await this.emitUpdate(bundle?.id ?? collectionId);
        const item = this.repository.getItem(bundle?.id ?? collectionId);
        return item ? this.enrichItem(item) : null;
    }

    public async remove(collectionId: string) {
        const bundle = this.repository.getBundle(collectionId);
        if (bundle) {
            for (const collection of this.repository.listBundleCollections(bundle.id)) {
                await this.scheduler.removeCollection(collection.id);
            }
            this.repository.deleteBundle(bundle.id);
            await this.cleanupBundlePacks(bundle.id);
            await this.emitUpdate();
            await this.kd.service.transfer.refreshPowerSaveBlock();
            return;
        }
        await this.scheduler.removeCollection(collectionId);
        this.repository.deleteCollection(collectionId);
        await this.emitUpdate();
        await this.kd.service.transfer.refreshPowerSaveBlock();
    }

    public async copyLink(collectionId: string) {
        const bundle = this.repository.getBundle(collectionId);
        if (bundle) {
            throw new Error("확장 공유 정보는 파일로 저장하세요.");
        }
        const collection = this.repository.getCollection(collectionId);
        if (!collection?.shareLink) {
            throw new Error("공유 링크가 아직 생성되지 않았습니다.");
        }
        clipboard.writeText(collection.shareLink);
    }

    public async saveShareInfo(collectionId: string) {
        const bundle = this.repository.getBundle(collectionId);
        if (!bundle) {
            throw new Error("확장 공유 정보를 찾을 수 없습니다.");
        }
        if (!bundle.shareValue) {
            throw new Error("공유 정보가 아직 생성되지 않았습니다.");
        }

        const baseName =
            this.kd.lib.fs.sanitizeWindowsFilename(bundle.name, "_").slice(0, 120) || "share";
        if (bundle.mode === "integrated") {
            const saveResult = await showSaveDialog({
                title: "확장 공유 정보 저장",
                defaultPath: `${baseName}.kds`,
                filters: KDS_FILTERS,
            });
            if (saveResult.canceled || !saveResult.filePath) {
                return null;
            }
            const filePath = saveResult.filePath.endsWith(".kds")
                ? saveResult.filePath
                : `${saveResult.filePath}.kds`;
            await withLoggedError(
                this.kd.logger,
                "UploadService:saveShareInfo",
                {
                    channel: "upload:saveShareInfo",
                    stage: "write-kds",
                    bundleId: bundle.id,
                    bundleName: bundle.name,
                    filePath,
                },
                async () => {
                    const bytes = encodeExtendedShareFile(bundle.shareValue!);
                    await fse.writeFile(filePath, bytes);
                },
            );
            return { filePath };
        }

        const saveResult = await showSaveDialog({
            title: "호환 공유 정보 저장",
            defaultPath: `${baseName}.txt`,
            filters: COMPAT_SHARE_FILTERS,
        });
        if (saveResult.canceled || !saveResult.filePath) {
            return null;
        }
        const filePath = saveResult.filePath.endsWith(".txt")
            ? saveResult.filePath
            : `${saveResult.filePath}.txt`;
        await withLoggedError(
            this.kd.logger,
            "UploadService:saveShareInfo",
            {
                channel: "upload:saveShareInfo",
                stage: "write-txt",
                bundleId: bundle.id,
                bundleName: bundle.name,
                filePath,
            },
            () => fse.writeFile(filePath, bundle.shareValue!, "utf8"),
        );
        return { filePath };
    }

    public async copyPassword(collectionId: string) {
        const password =
            this.repository.getBundle(collectionId)?.passwordPlain ??
            this.repository.getCollection(collectionId)?.passwordPlain;
        if (!password) throw new Error("복사할 비밀번호가 없습니다.");
        clipboard.writeText(password);
    }

    public async replaceFailedCollection(bundleId: string) {
        const context: Record<string, unknown> = {
            channel: "upload:replaceFailedCollection",
            bundleId,
            stage: "resolve-failed-collection",
        };
        // Serialize against bundle initialization: both create physical
        // collections for the same bundle and must not interleave.
        const existing = this.bundleInitializations.get(bundleId);
        if (existing) return existing;
        const task = withLoggedError(
            this.kd.logger,
            "UploadService:replaceFailedCollection",
            context,
            async () => {
                const bundle = this.repository.getBundle(bundleId);
                if (!bundle || bundle.mode !== "integrated") {
                    throw new Error("교체할 통합 업로드를 찾을 수 없습니다.");
                }
                const failed = this.repository
                    .listBundleCollections(bundle.id)
                    .find(
                        (collection) =>
                            collection.status === "error" || collection.status === "expired",
                    );
                if (!failed) throw new Error("교체가 필요한 물리 컬렉션이 없습니다.");

                Object.assign(context, {
                    collectionId: failed.id,
                    collectionOrdinal: failed.ordinal,
                    stage: "create-replacement",
                });
                await this.scheduler.removeCollection(failed.id);
                const plan = JSON.parse(bundle.planJson) as PersistedBundlePlan;
                // Supersede before creating the replacement so the partial unique
                // index on (bundle_id, ordinal) WHERE superseded = 0 does not
                // reject the new row. Roll back if creation fails so the failed
                // collection remains visible for a later retry.
                this.repository.supersedeCollection(failed.id);
                try {
                    await this.createBundleCollection(bundle, plan, failed.ordinal);
                } catch (error) {
                    this.repository.restoreSupersededCollection(failed.id);
                    throw error;
                }
                Object.assign(context, { stage: "activate-replacement" });
                this.repository.queueBundle(bundle.id);
                this.notifiedFailures.delete(bundle.id);
                await this.emitUpdate(bundle.id);
                void this.scheduler.schedule();
                return this.repository.getItem(bundle.id);
            },
        ).finally(() => {
            if (this.bundleInitializations.get(bundleId) === task) {
                this.bundleInitializations.delete(bundleId);
            }
        });
        this.bundleInitializations.set(bundleId, task);
        return task;
    }

    public hasActiveTransfers() {
        return this.scheduler.hasActiveTransfers();
    }

    public listOsProgressTransfers() {
        const grouped = Map.groupBy(
            this.repository.listOsProgressRows(),
            (row) => row.bundleId ?? row.id,
        );
        return [...grouped.values()].map((rows) =>
            toOsProgressTransfer({
                status: rows.some((row) => row.status === "uploading")
                    ? "uploading"
                    : rows.some((row) => row.status === "error")
                      ? "error"
                      : (rows.find((row) => row.status !== "completed")?.status ?? "completed"),
                transferredBytes: rows.reduce(
                    (sum, row) =>
                        sum +
                        Number(row.transferredBytes) +
                        this.metrics.getCollectionSnapshot(row.id).activeTransferredBytes,
                    0,
                ),
                totalBytes: rows.reduce((sum, row) => sum + Number(row.totalBytes), 0),
            }),
        );
    }

    public async restoreStartupState() {
        const mode = await this.kd.setting.get("transfer.uploadStartupResumeMode");
        this.repository.restoreStartupState();
        await this.scheduler.restoreFromRepository();
        for (const bundle of this.repository.listBundles()) {
            const collections = this.repository.listBundleCollections(bundle.id);
            if (
                !bundle.shareValue &&
                collections.length === bundle.physicalCount &&
                collections.every((collection) => collection.status === "completed")
            ) {
                await this.finalizeBundle(bundle, collections);
            }
        }
        await this.emitUpdate();
        if (mode === "auto") {
            await this.scheduler.schedule();
        }
    }

    public destroy() {
        if (this.bundleProgressFlushTimer) {
            clearTimeout(this.bundleProgressFlushTimer);
            this.bundleProgressFlushTimer = null;
        }
        this.pendingBundleProgress.clear();
        this.preparationWorker.destroy();
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

    private async sanitizeCreateFiles(files: UploadSourceFile[]) {
        const asciiFilenames = await this.kd.setting.get("general.asciiFilenames");
        return this.kd.lib.fs.sanitizeUploadFiles(files, asciiFilenames);
    }

    private async createBundle(payload: CreateUploadPayload, mode: ExtendedUploadMode) {
        const resolved = await this.resolveCreateFiles(payload.tree);
        const files = mode === "compatible" ? await this.sanitizeCreateFiles(resolved) : resolved;
        const bundleId = randomUUID();

        const persistedPlan =
            mode === "integrated"
                ? await this.createIntegratedBundlePlan(files, bundleId)
                : this.createCompatibleBundlePlan(
                      files,
                      new Map(files.map((file) => [file.path, file])),
                      bundleId,
                  );

        this.repository.insertBundle({
            id: bundleId,
            mode,
            name: payload.options.name.trim().slice(0, 100),
            description: payload.options.description.slice(0, 2500),
            password: payload.options.password,
            treeJson: JSON.stringify(buildDirTreeFromFiles(files)),
            planJson: JSON.stringify(persistedPlan),
            physicalCount: persistedPlan.collections.length,
            expires: payload.options.expires,
        });
        this.clearDraftSources();
        await this.emitUpdate(bundleId);
        await this.initializeBundle(this.repository.getBundle(bundleId)!, persistedPlan);
        return this.repository.getItem(bundleId);
    }

    private createCompatibleBundlePlan(
        files: UploadSourceFile[],
        sourcesByPath: Map<string, UploadSourceFile>,
        bundleId: string,
    ): PersistedBundlePlan {
        const planned = createExtendedUploadPlan(files, "compatible");
        if (!planned.ok) {
            throw new Error(
                `호환 공유에서는 50 GiB를 초과한 파일을 업로드할 수 없습니다: ${planned.oversizedFiles
                    .map((file) => file.path)
                    .join(", ")}`,
            );
        }
        return {
            collections: planned.collections.map((collection) => ({
                files: collection.pieces.map((piece) => {
                    const source = sourcesByPath.get(piece.sourcePath);
                    if (!source) {
                        throw new Error(`업로드 원본 경로를 찾을 수 없습니다: ${piece.sourcePath}`);
                    }
                    return pieceToPersistedFile(source, piece, bundleId);
                }),
            })),
        };
    }

    private async createIntegratedBundlePlan(
        files: UploadSourceFile[],
        bundleId: string,
    ): Promise<PersistedBundlePlan> {
        const packDir = path.join(app.getPath("userData"), "upload-packs", bundleId);
        return this.preparationWorker.planIntegrated({ bundleId, packDir, files }, (progress) => {
            this.kd.ipc.sendToMainWindow("upload:plan-progress", progress);
        });
    }

    private initializeBundle(bundle: UploadBundleRow, plan?: PersistedBundlePlan) {
        // Single-flight per bundle: concurrent resume requests for the same
        // bundle share one in-flight initialization so two callers cannot both
        // decide "ordinal N is missing" and create a duplicate collection.
        const existing = this.bundleInitializations.get(bundle.id);
        if (existing) return existing;
        const task = this.initializeBundleInternal(bundle, plan).finally(() => {
            if (this.bundleInitializations.get(bundle.id) === task) {
                this.bundleInitializations.delete(bundle.id);
            }
        });
        this.bundleInitializations.set(bundle.id, task);
        return task;
    }

    private async initializeBundleInternal(bundle: UploadBundleRow, plan?: PersistedBundlePlan) {
        const resolvedPlan = plan ?? (JSON.parse(bundle.planJson) as PersistedBundlePlan);
        this.turnstile.beginSession(this.kd.window.main.window);
        try {
            for (let ordinal = 0; ordinal < resolvedPlan.collections.length; ordinal += 1) {
                // Re-check on every iteration: even within the single-flight lock
                // the partial unique index is the hard guard, but this avoids
                // needless work (and a wasted turnstile/API attempt) when an
                // ordinal was already created by an earlier completed run.
                if (this.repository.hasBundleCollectionOrdinal(bundle.id, ordinal)) continue;
                await this.createBundleCollection(bundle, resolvedPlan, ordinal);
                this.repository.updateBundleInitialization(bundle.id, ordinal + 1);
                await this.emitUpdate(bundle.id);
            }
            this.repository.queueBundle(bundle.id);
            await this.emitUpdate(bundle.id);
            void this.scheduler.schedule();
        } catch (error) {
            this.repository.markBundleStatus(
                bundle.id,
                "paused",
                error instanceof Error ? error.message : String(error),
            );
            await this.emitUpdate(bundle.id);
        } finally {
            this.turnstile.endSession();
        }
    }

    private async createBundleCollection(
        bundle: UploadBundleRow,
        plan: PersistedBundlePlan,
        ordinal: number,
    ) {
        const context: Record<string, unknown> = {
            action: "initialize-extended-upload",
            bundleId: bundle.id,
            mode: bundle.mode,
            collectionOrdinal: ordinal,
            physicalCollectionCount: plan.collections.length,
            stage: "turnstile",
        };
        return withLoggedError(
            this.kd.logger,
            "UploadService:createBundleCollection",
            context,
            async () => {
                const files = await this.prepareBundleCollectionFiles(bundle, plan, ordinal);
                const token = await this.turnstile.solve(this.kd.window.main.window, {
                    current: ordinal + 1,
                    total: plan.collections.length,
                });
                context.stage = "create-collection";
                const options = {
                    name: `${bundle.name} (${ordinal + 1}/${plan.collections.length})`,
                    description: bundle.description,
                    password: bundle.passwordPlain ?? "",
                    expires: bundle.expires,
                };
                const created = await this.api.createCollection(files, options, token);
                context.stage = "persist-collection";
                const collectionId = this.repository.insertUpload({
                    created,
                    options,
                    files,
                    segmentSize: UPLOAD_SEGMENT_SIZE,
                    tree: buildDirTreeFromFiles(files),
                    bundleId: bundle.id,
                    ordinal,
                });
                this.backfillRemoteIds(collectionId, created.workItems);
                const fileRows = this.repository.listFiles(collectionId);
                this.scheduler.registerWorkItems(
                    collectionId,
                    fileRows.map((file) => ({ id: file.id, remoteId: file.remoteId })),
                    created.workItems,
                );
            },
        );
    }

    private async prepareBundleCollectionFiles(
        bundle: UploadBundleRow,
        plan: PersistedBundlePlan,
        ordinal: number,
    ) {
        const collectionFiles = plan.collections[ordinal].files;
        // Materialize all small-file packs for this collection in the worker so
        // source hashing and pack writes stay off the main event loop.
        const packFiles = collectionFiles.filter((file) => file.packEntries);
        const materialized =
            packFiles.length > 0 ? await this.preparationWorker.materializePacks(packFiles) : [];
        const materializedByPath = new Map(materialized.map((file) => [file.path, file] as const));

        const prepared: UploadSourceFile[] = [];
        for (const [fileIndex, file] of collectionFiles.entries()) {
            if (file.packEntries) {
                const materializedFile = materializedByPath.get(file.path);
                if (!materializedFile) {
                    throw new Error(`묶음 파일 생성 결과를 찾을 수 없습니다: ${file.path}`);
                }
                prepared.push(materializedFile);
                continue;
            }
            const logicalPath = file.logicalPath ?? file.path;
            const needsInternalName =
                bundle.mode === "integrated" &&
                file.logicalSize === file.size &&
                !isKioskCompatiblePath(logicalPath);
            if (!needsInternalName) {
                prepared.push(file);
                continue;
            }

            if (!file.logicalSha256) {
                throw new Error(`통합 업로드 해시가 누락되었습니다: ${logicalPath}`);
            }
            const physicalPath = `kde_${bundle.id.replaceAll("-", "")}/${ordinal}_${fileIndex}`;
            prepared.push({
                ...file,
                path: physicalPath,
                name: path.basename(physicalPath),
            });
        }
        return prepared;
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
        const isBundle = item.mode === "integrated" || item.mode === "compatible";
        const subCollectionIds = isBundle
            ? this.repository.listBundleCollections(item.id).map((c) => c.id)
            : [];
        const progress: Record<string, UploadFileProgress> = {};

        for (const [pathKey, fileProgress] of Object.entries(item.progress)) {
            const physicalFileId = fileProgress.fileId.split("::", 1)[0];
            const snapshot =
                options.sampleSpeeds && fileProgress.status === "uploading"
                    ? this.metrics.sampleFile(physicalFileId, fileProgress.uploaded)
                    : this.metrics.getFileSnapshot(physicalFileId, fileProgress.uploaded);

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
        const collectionSpeedBps = isBundle
            ? item.status === "uploading" && options.sampleSpeeds
                ? this.metrics.sampleBundle(item.id, subCollectionIds)
                : this.metrics.getBundleSnapshot(item.id, subCollectionIds).speedBps
            : item.status === "uploading" && options.sampleSpeeds
              ? this.metrics.sampleCollection(item.id)
              : this.metrics.getCollectionSnapshot(item.id).speedBps;
        if (item.status !== "uploading") {
            if (isBundle) {
                this.metrics.clearBundle(item.id);
            } else {
                this.metrics.clearCollection(item.id);
            }
        }

        const activeTransferredBytes = isBundle
            ? this.metrics.getBundleSnapshot(item.id, subCollectionIds).activeTransferredBytes
            : this.metrics.getCollectionSnapshot(item.id).activeTransferredBytes;

        return {
            ...item,
            progress,
            summary: {
                ...item.summary,
                transferredBytes: Math.min(
                    item.summary.totalBytes,
                    item.summary.transferredBytes + activeTransferredBytes,
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
        if (fileIds.size === 0) {
            return;
        }
        const collection = this.repository.getCollection(collectionId);
        if (!collection) {
            return;
        }
        if (collection.bundleId) {
            this.queueBundleProgressUpdate(collection.bundleId, fileIds);
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

    private queueBundleProgressUpdate(bundleId: string, fileIds: ReadonlySet<string>) {
        const pending = this.pendingBundleProgress.get(bundleId) ?? new Set<string>();
        for (const fileId of fileIds) {
            pending.add(fileId);
        }
        this.pendingBundleProgress.set(bundleId, pending);
        if (this.bundleProgressFlushTimer) {
            return;
        }
        this.bundleProgressFlushTimer = setTimeout(() => {
            this.bundleProgressFlushTimer = null;
            this.flushPendingBundleProgress();
        }, 0);
        this.bundleProgressFlushTimer.unref?.();
    }

    private flushPendingBundleProgress() {
        const pending = [...this.pendingBundleProgress.entries()];
        this.pendingBundleProgress.clear();
        for (const [bundleId, fileIds] of pending) {
            this.emitBundleProgressUpdate(bundleId, fileIds);
        }
    }

    private emitBundleProgressUpdate(bundleId: string, dirtyFileIds: ReadonlySet<string>) {
        const snapshot = this.repository.getBundleProgressSnapshot(bundleId, dirtyFileIds);
        if (!snapshot) {
            return;
        }
        const progress: Record<string, UploadFileProgress> = {};
        for (const [pathKey, fileProgress] of Object.entries(snapshot.progress)) {
            const physicalFileId = fileProgress.fileId.split("::", 1)[0];
            const metricsSnapshot =
                fileProgress.status === "uploading"
                    ? this.metrics.sampleFile(physicalFileId, fileProgress.uploaded)
                    : this.metrics.getFileSnapshot(physicalFileId, fileProgress.uploaded);
            const uploaded = Math.min(
                fileProgress.size,
                Math.max(fileProgress.uploaded, metricsSnapshot.uploaded),
            );
            progress[pathKey] = {
                ...fileProgress,
                uploaded,
                speedBps:
                    fileProgress.status === "uploading" && metricsSnapshot.speedBps > 0
                        ? metricsSnapshot.speedBps
                        : undefined,
            };
        }
        const bundleSnapshot = this.metrics.getBundleSnapshot(bundleId, snapshot.subCollectionIds);
        const speedBps =
            snapshot.status === "uploading"
                ? this.metrics.sampleBundle(bundleId, snapshot.subCollectionIds)
                : 0;
        if (snapshot.status !== "uploading") {
            this.metrics.clearBundle(bundleId);
        }
        const patch: UploadProgressPatch = {
            id: bundleId,
            progress,
            summary: {
                ...snapshot.summary,
                transferredBytes: Math.min(
                    snapshot.summary.totalBytes,
                    snapshot.summary.transferredBytes + bundleSnapshot.activeTransferredBytes,
                ),
            },
            status: snapshot.status,
            speedBps: snapshot.status === "uploading" && speedBps > 0 ? speedBps : null,
            elapsedMs: snapshot.elapsedMs,
            updatedAt: snapshot.updatedAt,
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

    private async handleCollectionUpdate(collectionId: string) {
        const collection = this.repository.getCollection(collectionId);
        if (!collection?.bundleId) {
            await this.emitUpdate(collectionId);
            return;
        }
        const bundle = this.repository.getBundle(collection.bundleId);
        if (!bundle) return;
        const collections = this.repository.listBundleCollections(bundle.id);
        if (collection.status === "error" || collection.status === "expired") {
            this.repository.markBundleStatus(bundle.id, "error", collection.error);
            this.notifyBundleFailure(bundle);
        } else if (
            collections.length === bundle.physicalCount &&
            collections.every((candidate) => candidate.status === "completed")
        ) {
            await this.finalizeBundle(bundle, collections);
        } else if (collection.status === "completed") {
            this.repository.queueBundle(bundle.id);
            void this.scheduler.schedule();
        }
        await this.emitUpdate(bundle.id);
    }

    private notifyBundleFailure(bundle: UploadBundleRow) {
        if (this.notifiedFailures.has(bundle.id)) return;
        this.notifiedFailures.add(bundle.id);
        const window = this.kd.window.main.window;
        if (window?.isFocused()) return;
        if (!Notification.isSupported()) return;
        const notification = new Notification({
            title: "확장 업로드에 조치가 필요합니다",
            body: `${bundle.name}의 물리 컬렉션 업로드에 실패했습니다.`,
        });
        notification.on("click", () => this.kd.window.main.focus());
        notification.show();
    }

    private async finalizeBundle(
        bundle: UploadBundleRow,
        collections = this.repository.listBundleCollections(bundle.id),
    ) {
        if (bundle.shareValue) return;
        const shareValue =
            bundle.mode === "compatible"
                ? formatCompatShareText({
                      title: bundle.name,
                      urls: collections.map((collection) => collection.shareLink ?? ""),
                      expiresAt: bundle.expires,
                      password: bundle.passwordPlain ?? undefined,
                  })
                : await encodeExtendedShare(
                      {
                          collectionIds: collections.map((collection) =>
                              Buffer.from(collection.collectionUuid, "hex"),
                          ),
                          splitFiles: this.buildExtendedSplitFiles(bundle.id, collections),
                      },
                      bundle.passwordPlain ?? undefined,
                  );
        this.repository.completeBundle(bundle.id, shareValue);
        const dedup = this.metrics.getBundleSegmentDedupSnapshot(collections.map((c) => c.id));
        const totalSegments = dedup.existsCount + dedup.conflictCount + dedup.uploadedCount;
        if (totalSegments > 0) {
            this.kd.logger.info(
                {
                    action: "upload-bundle-segment-dedup",
                    bundleId: bundle.id,
                    mode: bundle.mode,
                    ...dedup,
                    reusedBytes: dedup.existsBytes + dedup.conflictBytes,
                    edgePutRatio:
                        dedup.uploadedBytes /
                        Math.max(1, dedup.existsBytes + dedup.conflictBytes + dedup.uploadedBytes),
                },
                "UploadService:bundleSegmentDedup",
            );
        }
        this.metrics.clearSegmentDedup(collections.map((c) => c.id));
        await this.cleanupBundlePacks(bundle.id);
    }

    private buildExtendedSplitFiles(
        bundleId: string,
        collections: ReturnType<UploadRepository["listBundleCollections"]>,
    ) {
        const sourceIndexByCollection = new Map(
            collections.map((collection, sourceIndex) => [collection.id, sourceIndex]),
        );
        const splitFiles = new Map<string, ReturnType<UploadRepository["listBundleFiles"]>>();
        for (const file of this.repository.listBundleFiles(bundleId)) {
            if (!file.logicalSha256) continue;
            const pieces = splitFiles.get(file.logicalPath ?? file.path) ?? [];
            pieces.push(file);
            splitFiles.set(file.logicalPath ?? file.path, pieces);
        }
        const mappedFiles: ExtendedShareSplitFile[] = [...splitFiles].map(
            ([logicalPath, pieces]) => ({
                path: logicalPath,
                size: pieces[0].logicalSize ?? pieces.reduce((sum, piece) => sum + piece.size, 0),
                sha256: Buffer.from(pieces[0].logicalSha256!, "hex"),
                pieces: pieces
                    .toSorted((left, right) => left.sourceOffset - right.sourceOffset)
                    .map((piece) => ({
                        sourceIndex: sourceIndexByCollection.get(piece.collectionId)!,
                        remoteFileId: Buffer.from(piece.remoteId, "hex"),
                        offset: piece.sourceOffset,
                        length: piece.size,
                    })),
            }),
        );
        const plan = JSON.parse(
            this.repository.getBundle(bundleId)!.planJson,
        ) as PersistedBundlePlan;
        for (const [ordinal, plannedCollection] of plan.collections.entries()) {
            const collection = collections.find((candidate) => candidate.ordinal === ordinal);
            if (!collection) continue;
            const remoteByPath = new Map(
                this.repository
                    .listFiles(collection.id)
                    .map((file) => [file.path, file.remoteId] as const),
            );
            for (const plannedFile of plannedCollection.files) {
                if (!plannedFile.packEntries) continue;
                const remoteId = remoteByPath.get(plannedFile.path);
                if (!remoteId)
                    throw new Error(`묶음 파일 ID를 찾을 수 없습니다: ${plannedFile.path}`);
                mappedFiles.push(
                    ...plannedFile.packEntries.map((entry) => ({
                        path: entry.path,
                        size: entry.size,
                        sha256: entry.contentSha256
                            ? Buffer.from(entry.contentSha256, "hex")
                            : undefined,
                        pieces: [
                            {
                                sourceIndex: ordinal,
                                remoteFileId: Buffer.from(remoteId, "hex"),
                                offset: 0,
                                length: entry.size,
                                ...(entry.remoteOffset > 0
                                    ? { remoteOffset: entry.remoteOffset }
                                    : {}),
                            },
                        ],
                    })),
                );
            }
        }
        return mappedFiles;
    }

    private async cleanupBundlePacks(bundleId: string) {
        const packDir = path.join(app.getPath("userData"), "upload-packs", bundleId);
        await fse.remove(packDir).catch((error) => {
            this.kd.logger.error(
                {
                    action: "cleanup-extended-upload-packs",
                    bundleId,
                    packDir,
                    message: error instanceof Error ? error.message : String(error),
                },
                "UploadService:cleanupBundlePacks",
            );
        });
    }
}

const IGNORED_FOLDER_SCAN_BASENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function isIgnoredFolderScanFile(fileName: string) {
    return IGNORED_FOLDER_SCAN_BASENAMES.has(fileName.toLowerCase());
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
                const name = path.basename(entry.path);
                if (isIgnoredFolderScanFile(name)) continue;
                const relative = path.relative(input, entry.path);
                const treePath = normalizePath(`${rootName}/${relative}`);
                assertUniqueTreePath(seen, treePath);
                out.push({
                    path: treePath,
                    name,
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
