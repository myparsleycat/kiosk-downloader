import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { shouldCreateCollectionSubfolder } from "@shared/collection-path";
import { buildDirTreeFromFiles } from "@shared/dir-tree";
import {
    isCollectionInvalidPasswordError,
    isCollectionPasswordRequiredError,
    isExtendedShareInvalidPasswordError,
    isExtendedSharePasswordRequiredError,
    isZipInvalidPasswordError,
    isZipPasswordRequiredError,
} from "@shared/download-errors";
import type { TransferProviderRequestId } from "@shared/settings";
import {
    buildShareUrl,
    buildWorkuploadUrl,
    tryParseDownloadUrl,
    uuidBytesToShareId,
} from "@shared/share-url";
import { applyRenamesToTree, toDisplayPath, validateNodeName } from "@shared/tree-rename";
import type {
    Collection,
    CreateDownloadPayload,
    DownloadItem,
    DownloadProvider,
    FileProgress,
    ListZipEntriesPayload,
    ListZipEntriesResult,
    LoadCollectionPayload,
    PrepareDownloadPayload,
    PrepareDownloadResult,
    ResumePayload,
    ZipNode,
} from "@shared/types";
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
    LoadedWorkuploadCollection,
} from "./types";

import { logCaughtError, withLoggedError } from "../../lib/logged-error";
import {
    decodeExtendedShare,
    decodeExtendedShareFile,
    EXTENDED_SHARE_PREFIX,
    isExtendedShareFile,
    KDS_HEADER_SIZE,
    MAX_EXTENDED_SHARE_ENCODED_BYTES,
    type ExtendedSharePayload,
} from "../extended-share";
import { toOsProgressTransfer } from "../os-progress-bar";
import { showOpenDialog, showSaveDialog } from "../util";
import { BundleReassemblyCoordinator } from "./bundle-reassembly-coordinator";
import { reassembleExtendedFile } from "./extended-reassembly";
import { KioApiClient } from "./kio-api-client";
import { DownloadTransferMetrics } from "./metrics";
import { PartFileWriter, getBundleTempDirName, getStagingPartPath } from "./part-file";
import { DownloadRepository } from "./repository";
import { DownloadScheduler } from "./scheduler";
import {
    MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES,
    decodeDownloadTransfer,
    encodeDownloadTransfer,
} from "./transfer-format";
import { TransferItApiClient } from "./transfer-it-api-client";
import { parseWorkuploadFileSourceMeta } from "./types";
import { WorkuploadApiClient } from "./workupload-api-client";
import { uniquifyWorkuploadTree } from "./workupload-filenames";
import { indexZipFromSegments } from "./zip-index";

const KDX_FILTERS = [{ name: "Kiosk Download Transfer", extensions: ["kdx"] }];
const KDS_FILTERS = [{ name: "Kiosk Extended Share", extensions: ["kds"] }];
const MAX_SHARE_FILE_BYTES = KDS_HEADER_SIZE + MAX_EXTENDED_SHARE_ENCODED_BYTES;

type LoadedExtendedCollection = {
    collection: Collection;
    sources: LoadedKioskCollection[];
    manifest: ExtendedSharePayload;
};

type PreparedDownloadDraft = {
    id: string;
    sourceInput: string;
    password?: string;
    asciiFilenames: boolean;
    loaded: LoadedCollection | LoadedExtendedCollection;
};

type StoredExtendedManifest = {
    renames: Record<string, string>;
    selectedPaths?: string[];
    splitFiles: Array<{
        path: string;
        size: number;
        sha256?: string;
        pieces: Array<{
            sourceIndex: number;
            remoteFileId: string;
            offset: number;
            length: number;
            remoteOffset?: number;
        }>;
    }>;
};

export class DownloadService {
    private readonly api: KioApiClient;
    private readonly transferApi: TransferItApiClient;
    private readonly workuploadApi: WorkuploadApiClient;
    private readonly repository: DownloadRepository;
    private readonly metrics = new DownloadTransferMetrics();
    private readonly scheduler: DownloadScheduler;
    private preparedDraft: PreparedDownloadDraft | null = null;
    private prepareController: AbortController | null = null;
    private prepareGeneration = 0;
    private readonly reassemblyCoordinators = new Map<string, BundleReassemblyCoordinator>();
    private unsubscribeRequestPoolUsage?: () => void;
    private revision = 0;

    public constructor(private readonly kd: KioskDownloader) {
        this.api = new KioApiClient(kd);
        this.transferApi = new TransferItApiClient(kd);
        this.workuploadApi = new WorkuploadApiClient(kd);
        this.repository = new DownloadRepository(kd);
        this.scheduler = new DownloadScheduler(
            kd,
            this.api,
            this.transferApi,
            this.workuploadApi,
            this.repository,
            this.metrics,
            async (id) => {
                if (id) await this.handleCollectionUpdate(id);
                else await this.emitUpdate();
            },
            async (id, fileIds, usageDirty) => {
                await this.emitProgressUpdate(id, fileIds, usageDirty);
            },
            (collection, file) => {
                this.handleFileFinalized(collection, file);
            },
        );
    }

    public bindRequestPoolUsage() {
        this.unsubscribeRequestPoolUsage = this.kd.service.transfer.onRequestPoolUsageChange(
            (change) => {
                if (change.direction !== "download") {
                    return;
                }
                this.scheduler.markCollectionProgress(change.collectionId);
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
        const mode = await this.kd.setting.get("transfer.startupResumeMode");
        this.repository.restoreStartupState();
        await this.resetNonResumableWorkuploadStartupState();
        this.repository.syncExpiredCollections();
        await this.emitUpdate();
        for (const bundle of this.repository.listBundles()) {
            const collections = this.repository.listBundleCollections(bundle.id);
            if (
                bundle.status !== "completed" &&
                collections.length > 0 &&
                collections.every((collection) => collection.status === "completed")
            ) {
                await this.finalizeDownloadBundle(bundle.id);
            } else if (bundle.status !== "completed" && bundle.status !== "error") {
                this.restoreReassemblyCoordinator(bundle.id);
            }
        }
        await this.emitUpdate();
        if (mode === "auto") {
            void this.scheduler.schedule();
        }
    }

    public hasActiveTransfers() {
        return this.scheduler.hasActiveTransfers();
    }

    public refreshRequestScheduling() {
        void this.scheduler.schedule();
    }

    private async resetNonResumableWorkuploadStartupState() {
        for (const item of this.repository.listItems()) {
            if (item.collection.provider !== "workupload") {
                continue;
            }
            const collection = this.repository.getCollection(item.id);
            if (!collection) {
                continue;
            }
            const files = this.repository
                .listFiles(item.id)
                .filter(
                    (file) =>
                        file.status !== "completed" &&
                        tryParseWorkuploadFileSourceMeta(file.sourceMetaJson)?.rangeSupported !==
                            true,
                );
            if (files.length === 0) {
                continue;
            }
            await this.scheduler.cleanupPartFiles(collection, files);
            for (const file of files) {
                this.repository.resetFileProgress(file.id);
            }
        }
    }

    public listOsProgressTransfers() {
        const grouped = Map.groupBy(
            this.repository.listOsProgressRows(),
            (row) => row.bundleId ?? row.id,
        );
        return [...grouped.values()].map((rows) =>
            toOsProgressTransfer({
                status: rows.some((row) => row.status === "downloading")
                    ? "downloading"
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

    public destroy() {
        this.prepareGeneration += 1;
        this.prepareController?.abort();
        this.prepareController = null;
        this.preparedDraft = null;
        this.unsubscribeRequestPoolUsage?.();
        this.scheduler.destroy();
    }

    public async prepare(payload: PrepareDownloadPayload): Promise<PrepareDownloadResult> {
        this.prepareController?.abort();
        const controller = new AbortController();
        this.prepareController = controller;
        const generation = ++this.prepareGeneration;
        this.preparedDraft = null;
        const sourceInput = payload.url.trim();
        const parsed = tryParseDownloadUrl(sourceInput);
        if (!parsed && !sourceInput.startsWith(EXTENDED_SHARE_PREFIX)) {
            this.prepareController = null;
            return { status: "failed", code: "invalidUrl", message: "Invalid share URL." };
        }

        const asciiFilenames =
            payload.asciiFilenames ?? (await this.kd.setting.get("general.asciiFilenames"));
        const attempt = async (password?: string) => {
            const loadPayload = { url: sourceInput, password, signal: controller.signal };
            const loaded = sourceInput.startsWith(EXTENDED_SHARE_PREFIX)
                ? await this.loadExtendedCollection(loadPayload)
                : await this.loadCollectionUnlocked(loadPayload, asciiFilenames);
            if (generation !== this.prepareGeneration) {
                throw new DOMException("The operation was aborted.", "AbortError");
            }
            return { loaded, password };
        };

        try {
            let prepared: Awaited<ReturnType<typeof attempt>>;
            try {
                prepared = await attempt(payload.password);
            } catch (error) {
                const invalid =
                    isCollectionInvalidPasswordError(error) ||
                    isExtendedShareInvalidPasswordError(error);
                const required =
                    isCollectionPasswordRequiredError(error) ||
                    isExtendedSharePasswordRequiredError(error);
                if (payload.password && invalid) {
                    return { status: "passwordRequired", invalid: true };
                }
                if (!payload.password && required) {
                    const settings = await this.kd.setting.getMany([
                        "general.autoTryCollectionPasswords",
                        "general.collectionPasswordList",
                    ]);
                    if (!settings["general.autoTryCollectionPasswords"]) {
                        return { status: "passwordRequired", invalid: false };
                    }
                    let matched: Awaited<ReturnType<typeof attempt>> | null = null;
                    for (const candidate of settings["general.collectionPasswordList"]) {
                        if (generation !== this.prepareGeneration) {
                            throw new DOMException("The operation was aborted.", "AbortError");
                        }
                        try {
                            matched = await attempt(candidate);
                            break;
                        } catch (candidateError) {
                            if (
                                !isCollectionInvalidPasswordError(candidateError) &&
                                !isExtendedShareInvalidPasswordError(candidateError)
                            ) {
                                throw candidateError;
                            }
                        }
                    }
                    if (!matched) {
                        return { status: "passwordRequired", invalid: false };
                    }
                    prepared = matched;
                } else {
                    throw error;
                }
            }

            const id = randomUUID();
            this.preparedDraft = {
                id,
                sourceInput,
                password: prepared.password,
                asciiFilenames,
                loaded: prepared.loaded,
            };
            this.prepareController = null;
            const collection = prepared.loaded.collection;
            return {
                status: "ready",
                draftId: id,
                collection:
                    "resource" in prepared.loaded
                        ? { ...collection, resource: prepared.loaded.resource }
                        : collection,
            };
        } catch (error) {
            if (generation !== this.prepareGeneration) {
                return {
                    status: "failed",
                    code: "remoteFailure",
                    message: "Preparation superseded.",
                };
            }
            logCaughtError(
                this.kd.logger,
                "DownloadService:prepare",
                { channel: "download:prepare", stage: "load", url: sourceInput },
                error,
            );
            return {
                status: "failed",
                code: "remoteFailure",
                message: error instanceof Error ? error.message : String(error),
            };
        } finally {
            if (this.prepareController === controller) {
                this.prepareController = null;
            }
        }
    }

    public discardDraft(payload: { draftId?: string }) {
        if (payload.draftId && this.preparedDraft?.id !== payload.draftId) {
            return;
        }
        this.prepareGeneration += 1;
        this.prepareController?.abort();
        this.prepareController = null;
        this.preparedDraft = null;
    }

    public async listZipEntries(payload: ListZipEntriesPayload): Promise<ListZipEntriesResult> {
        const staleDraft = {
            status: "failed" as const,
            code: "staleDraft" as const,
            message: "Prepared download draft is no longer available.",
        };
        if (!this.preparedDraft || this.preparedDraft.id !== payload.draftId) {
            return staleDraft;
        }
        const draft = this.preparedDraft;
        if ("manifest" in draft.loaded || draft.loaded.provider !== "kiosk") {
            return {
                status: "failed",
                code: "unsupportedProvider",
                message: "ZIP entry browsing is not supported for this provider.",
            };
        }
        const loaded = draft.loaded;
        const found = findZipNodeById(loaded.collection.tree, payload.fileId);
        if (!found) {
            return {
                status: "failed",
                code: "zipNotFound",
                message: `ZIP file not found: ${payload.fileId}`,
            };
        }
        return withLoggedError(
            this.kd.logger,
            "DownloadService:listZipEntries",
            {
                channel: "download:listZipEntries",
                stage: "index",
                draftId: payload.draftId,
                fileId: payload.fileId,
            },
            async () => {
                const indexed = await this.indexZipNode(
                    loaded,
                    found.zip.id,
                    found.zip.size,
                    payload.zipPassword,
                );
                if (this.preparedDraft !== draft) {
                    return staleDraft;
                }
                loaded.collection = {
                    ...loaded.collection,
                    tree: setZipEntries(loaded.collection.tree, payload.fileId, indexed.entries),
                };
                return { status: "ready" as const, entries: indexed.entries };
            },
        ).catch((error) => {
            if (isZipPasswordRequiredError(error) || isZipInvalidPasswordError(error)) {
                return {
                    status: "passwordRequired",
                    invalid: isZipInvalidPasswordError(error),
                } as const;
            }
            throw error;
        });
    }

    public async create(payload: CreateDownloadPayload) {
        const draft = this.requirePreparedDraft(payload.draftId);
        if ("manifest" in draft.loaded) {
            return await this.createExtendedDownload(payload, draft);
        }
        const basePath = payload.savePath.trim();
        if (!basePath || !path.isAbsolute(basePath)) {
            throw new Error("Download save path must be absolute.");
        }
        const createCollectionSubfolder = await this.kd.setting.get(
            "general.createCollectionSubfolder",
        );
        const asciiFilenames = draft.asciiFilenames;
        const loaded = draft.loaded;
        const selectedPaths = new Set(payload.selectedPaths);
        const renames = payload.renames ?? {};
        let tree = loaded.collection.tree;

        if (loaded.provider === "kiosk") {
            for (const { zip, path: originalZipPath } of listZipNodes(tree)) {
                const displayZipPath = toDisplayPath(originalZipPath, renames);
                if (!isZipExtractMode(displayZipPath, selectedPaths)) {
                    continue;
                }
                if (!zip.entries) {
                    const zipPassword = payload.zipPasswords?.[zip.id];
                    const indexed = await this.indexZipNode(loaded, zip.id, zip.size, zipPassword);
                    tree = setZipEntries(tree, zip.id, indexed.entries);
                }
            }
        }

        tree = validateDraftTreeMutation(tree, payload.selectedPaths, renames);
        if (loaded.provider === "workupload") {
            const usedNames = new Set<string>();
            for (const entry of tree.entries) {
                const safeName = this.kd.lib.fs.sanitizeDownloadPathSegment(entry.node.name, {
                    asciiFilenames,
                });
                const key = safeName.toLowerCase();
                if (usedNames.has(key)) {
                    throw new Error("Workupload file names collide after sanitization.");
                }
                usedNames.add(key);
            }
        }

        const enriched: LoadedCollection = {
            ...loaded,
            collection: {
                ...loaded.collection,
                tree,
            },
        };
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
            url:
                enriched.provider === "workupload"
                    ? buildWorkuploadUrl(enriched.collection.shareId, enriched.resource)
                    : draft.sourceInput,
            password: enriched.passwordProtected ? draft.password : undefined,
            savePath,
            selectedPaths: payload.selectedPaths,
            asciiFilenames,
            zipPasswords: payload.zipPasswords,
        });
        await this.emitUpdate(collectionId);
        void this.scheduler.schedule();
        void this.kd.setting.set("general.lastDownloadPath", basePath);
        const item = this.getEnrichedItem(collectionId);
        if (!item) {
            throw new Error("Created download item is missing.");
        }
        this.preparedDraft = null;
        return item;
    }

    private requirePreparedDraft(draftId: string) {
        if (!this.preparedDraft || this.preparedDraft.id !== draftId) {
            throw new Error("Prepared download draft is no longer available.");
        }
        return this.preparedDraft;
    }

    private async loadCollectionUnlocked(
        payload: {
            url: string;
            password?: string;
            signal?: AbortSignal;
        },
        asciiFilenames: boolean,
    ): Promise<LoadedCollection> {
        const parsed = tryParseDownloadUrl(payload.url);
        if (!parsed) {
            throw new Error("Invalid share URL.");
        }
        if (parsed.provider === "transfer") {
            return this.transferApi.loadCollection(payload);
        }
        if (parsed.provider === "workupload") {
            return this.normalizeWorkuploadCollection(
                await this.workuploadApi.loadCollection(payload),
                asciiFilenames,
            );
        }
        return this.api.loadCollection(payload);
    }

    private normalizeWorkuploadCollection(
        loaded: LoadedWorkuploadCollection,
        asciiFilenames: boolean,
    ): LoadedWorkuploadCollection {
        return {
            ...loaded,
            collection: {
                ...loaded.collection,
                tree: uniquifyWorkuploadTree(loaded.collection.tree, (name) =>
                    this.kd.lib.fs.sanitizeDownloadPathSegment(name, { asciiFilenames }),
                ).tree,
            },
        };
    }

    private async loadExtendedCollection(
        payload: LoadCollectionPayload & { signal?: AbortSignal },
    ): Promise<LoadedExtendedCollection> {
        if (payload.signal?.aborted) {
            throw payload.signal.reason;
        }
        const sourceInput = payload.url.trim();
        const manifest = await decodeExtendedShare(sourceInput, payload.password);
        const sources: LoadedKioskCollection[] = [];
        for (const [index, collectionId] of manifest.collectionIds.entries()) {
            if (payload.signal?.aborted) {
                throw payload.signal.reason;
            }
            this.kd.ipc.sendToMainWindow("download:extended-load-progress", {
                current: index + 1,
                total: manifest.collectionIds.length,
            });
            sources.push(
                await this.api.loadCollection({
                    url: buildShareUrl(uuidBytesToShareId(collectionId)),
                    password: payload.password,
                    signal: payload.signal,
                }),
            );
        }
        const expires = sources[0]?.collection.expires;
        if (expires == null || sources.some((source) => source.collection.expires !== expires)) {
            throw new Error("확장 공유의 컬렉션 만료 시각이 일치하지 않습니다.");
        }
        const remoteFilesBySource = sources.map(
            (source) =>
                new Map(
                    flattenRemoteFiles(source.collection.tree).map((file) => [file.remoteId, file]),
                ),
        );
        for (const splitFile of manifest.splitFiles) {
            for (const piece of splitFile.pieces) {
                const remote = remoteFilesBySource[piece.sourceIndex]?.get(
                    piece.remoteFileId.toString("hex"),
                );
                if (!remote || (piece.remoteOffset ?? 0) + piece.length > remote.size) {
                    throw new Error(`확장 공유의 파일 조각이 일치하지 않습니다: ${splitFile.path}`);
                }
            }
        }

        const splitRemoteIds = new Set(
            manifest.splitFiles.flatMap((file) =>
                file.pieces.map((piece) => piece.remoteFileId.toString("hex")),
            ),
        );
        const logicalFiles = sources
            .flatMap((source) => flattenRemoteFiles(source.collection.tree))
            .filter((file) => !splitRemoteIds.has(file.remoteId))
            .map((file) => ({ path: file.path, name: file.name, size: file.size }));
        logicalFiles.push(
            ...manifest.splitFiles.map((file) => ({
                path: file.path,
                name: path.basename(file.path),
                size: file.size,
            })),
        );
        const name = sources[0].collection.name.replace(/ \(1\/\d+\)$/, "");
        return {
            manifest,
            sources,
            collection: {
                shareId: createHash("sha256").update(sourceInput).digest("base64url").slice(0, 22),
                name,
                expires,
                segmentSize: sources[0].collection.segmentSize,
                passwordProtected: Boolean(payload.password),
                provider: "extended",
                tree: buildDirTreeFromFiles(logicalFiles),
            },
        };
    }

    private async createExtendedDownload(
        payload: CreateDownloadPayload,
        draft: PreparedDownloadDraft,
    ) {
        if (!("manifest" in draft.loaded)) {
            throw new Error("Prepared draft is not an extended share.");
        }
        const sourceInput = draft.sourceInput;
        const loaded = draft.loaded;
        const renames = payload.renames ?? {};
        const logicalTree = validateDraftTreeMutation(
            loaded.collection.tree,
            payload.selectedPaths,
            renames,
        );
        const basePath = payload.savePath.trim();
        if (!basePath || !path.isAbsolute(basePath)) {
            throw new Error("Download save path must be absolute.");
        }
        const createCollectionSubfolder = await this.kd.setting.get(
            "general.createCollectionSubfolder",
        );
        const asciiFilenames = draft.asciiFilenames;
        const savePath = shouldCreateCollectionSubfolder(
            logicalTree,
            loaded.collection.name,
            createCollectionSubfolder,
        )
            ? path.join(
                  basePath,
                  this.kd.lib.fs.sanitizeDownloadPathSegment(loaded.collection.name, {
                      asciiFilenames,
                      sanitizeString: " ",
                  }),
              )
            : basePath;
        const bundleId = randomUUID();
        const storedManifest: StoredExtendedManifest = {
            renames,
            selectedPaths: [...new Set(payload.selectedPaths)],
            splitFiles: loaded.manifest.splitFiles.map((file) => ({
                path: toDisplayPath(file.path, renames),
                size: file.size,
                ...(file.sha256 ? { sha256: file.sha256.toString("hex") } : {}),
                pieces: file.pieces.map((piece) => ({
                    sourceIndex: piece.sourceIndex,
                    remoteFileId: piece.remoteFileId.toString("hex"),
                    offset: piece.offset,
                    length: piece.length,
                    ...(piece.remoteOffset ? { remoteOffset: piece.remoteOffset } : {}),
                })),
            })),
        };
        this.repository.insertBundle({
            id: bundleId,
            sourceInput,
            password: draft.password,
            name: loaded.collection.name,
            treeJson: JSON.stringify(logicalTree),
            manifestJson: JSON.stringify(storedManifest),
            savePath,
            expires: loaded.collection.expires,
        });

        const selected = new Set(payload.selectedPaths);
        let createdCollections = 0;
        try {
            for (let sourceIndex = 0; sourceIndex < loaded.sources.length; sourceIndex += 1) {
                const source = loaded.sources[sourceIndex];
                const logicalPathsByRemoteId = new Map<string, string[]>();
                for (const file of storedManifest.splitFiles) {
                    for (const piece of file.pieces) {
                        if (piece.sourceIndex !== sourceIndex) continue;
                        const paths = logicalPathsByRemoteId.get(piece.remoteFileId) ?? [];
                        paths.push(file.path);
                        logicalPathsByRemoteId.set(piece.remoteFileId, paths);
                    }
                }
                const selectedPhysicalPaths = flattenRemoteFiles(source.collection.tree)
                    .filter((file) => {
                        const logicalPaths = logicalPathsByRemoteId.get(file.remoteId);
                        return logicalPaths
                            ? logicalPaths.some((logicalPath) => selected.has(logicalPath))
                            : selected.has(toDisplayPath(file.path, renames));
                    })
                    .map((file) => file.path);
                if (selectedPhysicalPaths.length === 0) continue;
                this.repository.insertDownload({
                    loaded: source,
                    url: buildShareUrl(source.collection.shareId),
                    password: draft.password,
                    savePath: path.join(
                        savePath,
                        getBundleTempDirName(bundleId),
                        String(sourceIndex),
                    ),
                    selectedPaths: selectedPhysicalPaths,
                    asciiFilenames,
                    bundleId,
                    ordinal: sourceIndex,
                });
                createdCollections += 1;
            }
            if (createdCollections === 0) throw new Error("No files selected.");
        } catch (error) {
            this.repository.deleteBundle(bundleId);
            throw error;
        }

        this.createReassemblyCoordinator(bundleId, storedManifest);
        await this.emitUpdate(bundleId);
        void this.scheduler.schedule();
        void this.kd.setting.set("general.lastDownloadPath", basePath);
        const item = this.getEnrichedItem(bundleId);
        if (!item) {
            throw new Error("Created extended download item is missing.");
        }
        this.preparedDraft = null;
        return item;
    }

    private async indexZipNode(
        loaded: LoadedKioskCollection,
        remoteFileId: string,
        fileSize: number,
        zipPassword?: string,
    ) {
        const segments = await this.api.getSegments(remoteFileId, loaded.cat);
        return indexZipFromSegments({
            kd: this.kd,
            collectionId: loaded.collection.shareId,
            shareId: loaded.collection.shareId,
            remoteFileId,
            segments,
            segmentSize: loaded.collection.segmentSize,
            fileSize,
            zipPassword,
        });
    }

    public async list() {
        return {
            revision: this.revision,
            items: this.repository.listItems().map((item) => this.enrichItem(item)),
        };
    }

    public async pauseCollection(collectionId: string) {
        const bundle = this.repository.getBundle(collectionId);
        if (bundle) {
            const collections = this.repository.listBundleCollections(bundle.id);
            for (const collection of collections) {
                if (collection.status === "completed") continue;
                this.scheduler.pauseCollection(collection.id);
                this.repository.pauseCollection(collection.id);
            }
            this.repository.markBundleStatus(bundle.id, "paused");
            await this.emitUpdate(bundle.id);
            await this.kd.service.transfer.refreshPowerSaveBlock();
            return;
        }
        this.scheduler.pauseCollection(collectionId);
        this.repository.pauseCollection(collectionId);
        await this.emitUpdate(collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
    }

    public async resumeCollection(collectionId: string, options: ResumePayload = {}) {
        const bundle = this.repository.getBundle(collectionId);
        if (bundle) {
            const collections = this.repository.listBundleCollections(bundle.id);
            if (
                collections.length > 0 &&
                collections.every((collection) => collection.status === "completed")
            ) {
                this.repository.markBundleStatus(bundle.id, "queued");
                await this.finalizeDownloadBundle(bundle.id);
                await this.emitUpdate(bundle.id);
                return;
            }
            for (const collection of collections) {
                if (collection.status === "completed") continue;
                if (this.repository.ensureCollectionNotExpired(collection.id)) continue;
                this.repository.resumeCollection(collection.id, Boolean(options.force));
                this.scheduler.resumeCollection(collection.id);
            }
            this.repository.markBundleStatus(bundle.id, "queued");
            await this.emitUpdate(bundle.id);
            return;
        }
        if (this.repository.ensureCollectionNotExpired(collectionId)) {
            await this.emitUpdate(collectionId);
            return;
        }
        this.repository.resumeCollection(collectionId, Boolean(options.force));
        this.scheduler.resumeCollection(collectionId);
        await this.emitUpdate(collectionId);
    }

    public async pauseFile(downloadId: string, fileId: string) {
        const bundle = this.repository.getBundle(downloadId);
        if (bundle) {
            for (const file of this.listLogicalBundleFiles(bundle.id, fileId)) {
                this.scheduler.pauseFile(file.id);
                this.repository.pauseFile(file.id);
                this.repository.recomputeCollectionStatus(file.collectionId);
            }
            await this.emitUpdate(bundle.id);
            await this.kd.service.transfer.refreshPowerSaveBlock();
            return this.getEnrichedItem(bundle.id);
        }
        const file = this.repository.getFile(fileId);
        if (!file) {
            return null;
        }
        this.scheduler.pauseFile(fileId);
        this.repository.pauseFile(fileId);
        this.repository.recomputeCollectionStatus(file.collectionId);
        await this.emitUpdate(file.collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
        return this.getEnrichedItem(file.collectionId);
    }

    public async resumeFile(downloadId: string, fileId: string, options: ResumePayload = {}) {
        const bundle = this.repository.getBundle(downloadId);
        if (bundle) {
            for (const file of this.listLogicalBundleFiles(bundle.id, fileId)) {
                if (this.repository.ensureCollectionNotExpired(file.collectionId)) continue;
                this.repository.resumeFile(file.id, Boolean(options.force));
                this.repository.markCollectionStatus(file.collectionId, "queued");
                this.scheduler.resumeFile(file.id);
            }
            this.repository.markBundleStatus(bundle.id, "queued");
            await this.emitUpdate(bundle.id);
            return this.getEnrichedItem(bundle.id);
        }
        const file = this.repository.getFile(fileId);
        if (!file) {
            return null;
        }
        if (this.repository.ensureCollectionNotExpired(file.collectionId)) {
            await this.emitUpdate(file.collectionId);
            return this.getEnrichedItem(file.collectionId);
        }
        this.repository.resumeFile(fileId, Boolean(options.force));
        this.repository.markCollectionStatus(file.collectionId, "queued");
        this.scheduler.resumeFile(fileId);
        await this.emitUpdate(file.collectionId);
        return this.getEnrichedItem(file.collectionId);
    }

    public async includeFile(downloadId: string, fileId: string) {
        const file = this.repository.getFile(fileId);
        if (!file) {
            return null;
        }
        if (this.repository.ensureCollectionNotExpired(file.collectionId)) {
            await this.emitUpdate(file.collectionId);
            return this.getEnrichedItem(file.collectionId);
        }
        await withLoggedError(
            this.kd.logger,
            "DownloadService:includeFile",
            {
                channel: "download:includeFile",
                stage: "include",
                downloadId,
                fileId,
                filePath: file.path,
            },
            () => {
                this.repository.includeFile(fileId);
            },
        );
        this.repository.markCollectionStatus(file.collectionId, "queued");
        this.scheduler.resumeFile(fileId);
        await this.emitUpdate(file.collectionId);
        return this.getEnrichedItem(file.collectionId);
    }

    public async includeFolder(downloadId: string, folderPath: string) {
        const collection = this.repository.getCollection(downloadId);
        if (!collection) {
            return null;
        }
        if (this.repository.ensureCollectionNotExpired(downloadId)) {
            await this.emitUpdate(downloadId);
            return this.getEnrichedItem(downloadId);
        }

        const fileIds = await withLoggedError(
            this.kd.logger,
            "DownloadService:includeFolder",
            {
                channel: "download:includeFolder",
                stage: "include",
                downloadId,
                folderPath,
            },
            () => this.repository.includeFolder(downloadId, folderPath),
        );

        if (fileIds.length === 0) {
            return this.getEnrichedItem(downloadId);
        }

        this.repository.markCollectionStatus(downloadId, "queued");
        for (const fileId of fileIds) {
            this.scheduler.resumeFile(fileId);
        }
        await this.emitUpdate(downloadId);
        return this.getEnrichedItem(downloadId);
    }

    public async remove(collectionId: string) {
        const bundle = this.repository.getBundle(collectionId);
        if (bundle) {
            const coordinator = this.reassemblyCoordinators.get(bundle.id);
            if (coordinator) {
                await coordinator.teardown();
                this.reassemblyCoordinators.delete(bundle.id);
            }
            for (const collection of this.repository.listBundleCollections(bundle.id)) {
                const files = this.repository.listFiles(collection.id);
                this.scheduler.removeCollection(collection.id);
                await this.scheduler.cleanupPartFiles(collection, files);
            }
            this.repository.deleteBundle(bundle.id);
            await fse
                .remove(path.join(bundle.savePath, getBundleTempDirName(bundle.id)))
                .catch(() => undefined);
            await this.emitRemoved(collectionId);
            await this.kd.service.transfer.refreshPowerSaveBlock();
            return;
        }
        const collection = this.repository.getCollection(collectionId);
        const files = collection ? this.repository.listFiles(collectionId) : [];
        this.scheduler.removeCollection(collectionId);
        this.repository.deleteCollection(collectionId);
        if (collection) {
            await this.scheduler.cleanupPartFiles(collection, files);
        }
        await this.emitRemoved(collectionId);
        await this.kd.service.transfer.refreshPowerSaveBlock();
    }

    public async openFolder(collectionId: string) {
        const collection = this.repository.getCollection(collectionId);
        const bundle = this.repository.getBundle(collectionId);
        const savePath = bundle?.savePath ?? collection?.savePath;
        if (!savePath) {
            throw new Error("Download item not found.");
        }
        await fse.ensureDir(savePath);
        const result = await shell.openPath(savePath);
        if (result) {
            throw new Error(result);
        }
    }

    /**
     * Read a .kds share file.
     * - No payload: opens a trusted file picker and reads the selected path in main.
     * - `{ bytes }`: decodes caller-supplied contents (e.g. dropped File via preload).
     * Renderer-supplied filesystem paths are never accepted.
     */
    public async readShareFile(payload?: { bytes: Uint8Array }) {
        if (payload?.bytes) {
            return this.decodeShareFileBytes(payload.bytes);
        }

        const resolvedPath = (
            await showOpenDialog({
                title: "확장 공유 파일 선택",
                properties: ["openFile"],
                filters: KDS_FILTERS,
            })
        ).filePaths[0];
        if (!resolvedPath) {
            return null;
        }

        return withLoggedError(
            this.kd.logger,
            "DownloadService:readShareFile",
            {
                channel: "download:readShareFile",
                stage: "read",
                filePath: resolvedPath,
            },
            async () => {
                const stat = await fse.stat(resolvedPath);
                if (!stat.isFile()) {
                    throw new Error("확장 공유 파일이 아닙니다.");
                }
                if (stat.size > MAX_SHARE_FILE_BYTES) {
                    throw new Error("확장 공유 파일이 너무 큽니다.");
                }
                const bytes = await fse.readFile(resolvedPath);
                return this.decodeShareFileBuffer(bytes);
            },
        );
    }

    private async decodeShareFileBytes(bytes: Uint8Array) {
        return withLoggedError(
            this.kd.logger,
            "DownloadService:readShareFile",
            {
                channel: "download:readShareFile",
                stage: "decode-bytes",
                byteLength: bytes.byteLength,
            },
            async () => {
                if (bytes.byteLength > MAX_SHARE_FILE_BYTES) {
                    throw new Error("확장 공유 파일이 너무 큽니다.");
                }
                return this.decodeShareFileBuffer(Buffer.from(bytes));
            },
        );
    }

    private decodeShareFileBuffer(bytes: Buffer) {
        if (!isExtendedShareFile(bytes)) {
            throw new Error("유효한 .kds 파일이 아닙니다.");
        }
        return { shareInput: decodeExtendedShareFile(bytes) };
    }

    public async exportCollection(collectionId: string) {
        const collection = this.repository.getCollection(collectionId);
        if (!collection) {
            throw new Error("Download item not found.");
        }

        const payload = await withLoggedError(
            this.kd.logger,
            "DownloadService:exportCollection",
            {
                channel: "download:exportCollection",
                stage: "build",
                collectionId,
                collectionName: collection.name,
            },
            () => this.repository.buildTransferPayload(collectionId),
        );

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

        await withLoggedError(
            this.kd.logger,
            "DownloadService:exportCollection",
            {
                channel: "download:exportCollection",
                stage: "write",
                collectionId,
                collectionName: collection.name,
                filePath,
            },
            async () => {
                const bytes = encodeDownloadTransfer(payload);
                // Reject a bad encode before writing so disk never gets an invalid .kdx.
                decodeDownloadTransfer(bytes);
                await fse.writeFile(filePath, bytes);
            },
        );

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

        const payload = await withLoggedError(
            this.kd.logger,
            "DownloadService:importCollection",
            {
                channel: "download:importCollection",
                stage: "decode",
                transferPath,
            },
            async () => {
                if ((await fse.stat(transferPath)).size > MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES) {
                    throw new Error("Transfer file is too large.");
                }
                return decodeDownloadTransfer(await fse.readFile(transferPath));
            },
        );

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

        const collectionId = await withLoggedError(
            this.kd.logger,
            "DownloadService:importCollection",
            {
                channel: "download:importCollection",
                stage: "insert",
                transferPath,
                savePath,
                collectionName: payload.collection.name,
                shareId: payload.collection.shareId,
            },
            () => this.repository.insertImportedDownload(payload, savePath),
        );

        await this.emitUpdate(collectionId);
        const imported = this.repository.getCollection(collectionId);
        if (imported?.status === "queued") {
            void this.scheduler.schedule();
        }
        void this.kd.setting.set("general.lastDownloadPath", basePath);
        return this.getEnrichedItem(collectionId);
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

    private getEnrichedItem(collectionId: string) {
        const item = this.repository.getItem(collectionId);
        return item ? this.enrichItem(item) : null;
    }

    private enrichItem(item: DownloadItem, options: { sampleSpeeds?: boolean } = {}): DownloadItem {
        const isBundle = item.collection.provider === "extended";
        const subCollectionIds = isBundle
            ? this.repository.listBundleCollections(item.id).map((c) => c.id)
            : [];
        const requestPoolUsage = this.kd.service.transfer.getRequestPoolUsageSum(
            "download",
            requestPoolProviderId(item.collection.provider),
            isBundle ? subCollectionIds : [item.id],
        );
        const progress: Record<string, FileProgress> = {};

        for (const [path, fileProgress] of Object.entries(item.progress)) {
            const physicalFileId = fileProgress.fileId.split("::", 1)[0];
            const snapshot =
                options.sampleSpeeds && fileProgress.status === "downloading"
                    ? this.metrics.sampleFile(physicalFileId, fileProgress.downloaded)
                    : this.metrics.getFileSnapshot(physicalFileId, fileProgress.downloaded);
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
        const sampleSpeeds = item.status === "downloading" && options.sampleSpeeds;
        let collectionSpeedBps: number;
        if (isBundle) {
            collectionSpeedBps = sampleSpeeds
                ? this.metrics.sampleBundle(item.id, subCollectionIds)
                : this.metrics.getBundleSnapshot(item.id, subCollectionIds).speedBps;
        } else {
            collectionSpeedBps = sampleSpeeds
                ? this.metrics.sampleCollection(item.id)
                : this.metrics.getCollectionSnapshot(item.id).speedBps;
        }
        if (item.status !== "downloading") {
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
                item.status === "downloading" && collectionSpeedBps > 0
                    ? collectionSpeedBps
                    : undefined,
            elapsedMs,
            requestPoolUsage,
        };
    }

    private async emitProgressUpdate(
        collectionId: string,
        fileIds: Set<string>,
        usageDirty: boolean,
    ) {
        if (fileIds.size === 0 && !usageDirty) {
            return;
        }
        const collection = this.repository.getCollection(collectionId);
        if (!collection) {
            return;
        }
        await this.emitUpdate(collection.bundleId ?? collectionId, { sampleSpeeds: true });
    }

    private async emitUpdate(collectionId?: string, options: { sampleSpeeds?: boolean } = {}) {
        if (collectionId) {
            const item = this.repository.getItem(collectionId);
            if (item) {
                this.emitChanged(collectionId, this.enrichItem(item, options));
            }
            this.kd.service.transfer.syncMainWindowProgressBar();
            return;
        }

        for (const item of this.repository.listItems()) {
            this.emitChanged(item.id, this.enrichItem(item, options));
        }
        this.kd.service.transfer.syncMainWindowProgressBar();
    }

    private emitChanged(id: string, item: DownloadItem | null) {
        this.revision += 1;
        this.kd.ipc.sendToMainWindow("download:changed", {
            revision: this.revision,
            id,
            item,
        });
    }

    private async emitRemoved(id: string) {
        this.emitChanged(id, null);
        this.kd.service.transfer.syncMainWindowProgressBar();
    }

    private async handleCollectionUpdate(collectionId: string) {
        const bundle = this.repository.getBundleByCollection(collectionId);
        if (!bundle) {
            await this.emitUpdate(collectionId);
            return;
        }
        const collections = this.repository.listBundleCollections(bundle.id);
        const failed = collections.find(
            (collection) => collection.status === "error" || collection.status === "expired",
        );
        if (failed) {
            for (const collection of collections) {
                if (
                    collection.id === failed.id ||
                    collection.status === "completed" ||
                    collection.status === "paused"
                ) {
                    continue;
                }
                this.scheduler.pauseCollection(collection.id);
                this.repository.pauseCollection(collection.id);
            }
            this.repository.markBundleStatus(bundle.id, "error", failed.error);
            const coordinator = this.reassemblyCoordinators.get(bundle.id);
            if (coordinator) {
                await coordinator.teardown();
                this.reassemblyCoordinators.delete(bundle.id);
            }
        } else if (
            collections.length > 0 &&
            collections.every((collection) => collection.status === "completed")
        ) {
            await this.finalizeDownloadBundle(bundle.id);
        }
        await this.emitUpdate(bundle.id);
    }

    private createReassemblyCoordinator(bundleId: string, manifest: StoredExtendedManifest) {
        const bundle = this.repository.getBundle(bundleId);
        if (!bundle) return;
        const collections = this.repository.listBundleCollections(bundleId);
        if (collections.length === 0) return;
        const coordinator = new BundleReassemblyCoordinator(
            this.kd,
            bundleId,
            bundle.savePath,
            manifest,
            collections,
            (piece) => this.resolvePieceFilePath(bundleId, piece),
        );
        if (coordinator.hasManagedFiles()) {
            this.reassemblyCoordinators.set(bundleId, coordinator);
        }
    }

    private parseStoredManifest(
        bundleId: string,
        manifestJson: string,
    ): StoredExtendedManifest | null {
        try {
            return JSON.parse(manifestJson) as StoredExtendedManifest;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.kd.logger.error(
                {
                    action: "bundle-manifest-parse",
                    bundleId,
                    stage: "parse-manifest",
                    message,
                },
                "DownloadService:parseStoredManifest",
            );
            this.repository.markBundleStatus(bundleId, "error", message);
            void this.emitUpdate(bundleId);
            return null;
        }
    }

    private restoreReassemblyCoordinator(bundleId: string) {
        const bundle = this.repository.getBundle(bundleId);
        if (!bundle) return;
        const manifest = this.parseStoredManifest(bundleId, bundle.manifestJson);
        if (!manifest) return;
        this.createReassemblyCoordinator(bundleId, manifest);
        const coordinator = this.reassemblyCoordinators.get(bundleId);
        if (!coordinator) return;
        const collections = this.repository.listBundleCollections(bundleId);
        for (const collection of collections) {
            for (const file of this.repository.listFiles(collection.id)) {
                if (
                    file.status === "completed" &&
                    coordinator.isPieceManaged(collection.id, file.remoteId)
                ) {
                    this.runPieceFileSettled(bundleId, coordinator, collection.id, file.remoteId);
                }
            }
        }
    }

    private resolvePieceFilePath(
        bundleId: string,
        piece: { sourceIndex: number; remoteFileId: string },
    ): string | null {
        const bundle = this.repository.getBundle(bundleId);
        if (!bundle) return null;
        const collections = this.repository.listBundleCollections(bundleId);
        const collection = collections.find((c) => c.ordinal === piece.sourceIndex);
        if (!collection) return null;
        const file = this.repository
            .listFiles(collection.id)
            .find((candidate) => candidate.remoteId === piece.remoteFileId);
        if (!file) return null;
        return path.join(
            collection.savePath,
            this.kd.lib.fs.getSafeRelativePath(file.path, {
                asciiFilenames: collection.asciiFilenames === 1,
            }),
        );
    }

    private handleFileFinalized(collection: DownloadCollectionRow, file: DownloadFileRow) {
        if (!collection.bundleId) return;
        const coordinator = this.reassemblyCoordinators.get(collection.bundleId);
        if (!coordinator) return;
        if (!coordinator.isPieceManaged(collection.id, file.remoteId)) return;
        this.runPieceFileSettled(collection.bundleId, coordinator, collection.id, file.remoteId);
    }

    private runPieceFileSettled(
        bundleId: string,
        coordinator: BundleReassemblyCoordinator,
        collectionId: string,
        remoteId: string,
    ) {
        void coordinator
            .onPieceFileSettled(collectionId, remoteId)
            .then((result) => {
                if (result.publishedPaths.length > 0) {
                    void this.emitUpdate(bundleId);
                }
            })
            .catch(async (error) => {
                this.kd.logger.error(
                    {
                        action: "bundle-reassembly",
                        bundleId,
                        message: error instanceof Error ? error.message : String(error),
                    },
                    "DownloadService:runPieceFileSettled",
                );
                await coordinator.teardown();
                this.reassemblyCoordinators.delete(bundleId);
                this.repository.markBundleStatus(
                    bundleId,
                    "error",
                    error instanceof Error ? error.message : String(error),
                );
                void this.emitUpdate(bundleId);
            })
            .catch((error) => {
                this.kd.logger.error(
                    {
                        action: "bundle-reassembly-cleanup",
                        bundleId,
                        message: error instanceof Error ? error.message : String(error),
                    },
                    "DownloadService:runPieceFileSettled",
                );
            });
    }

    private async finalizeDownloadBundle(bundleId: string) {
        const bundle = this.repository.getBundle(bundleId);
        if (!bundle || bundle.status === "completed") return;
        const collections = this.repository.listBundleCollections(bundle.id);
        const manifest = JSON.parse(bundle.manifestJson) as StoredExtendedManifest;
        const collectionByOrdinal = new Map(
            collections.map((collection) => [collection.ordinal, collection]),
        );
        const splitRemoteIds = new Set(
            manifest.splitFiles.flatMap((file) => file.pieces.map((piece) => piece.remoteFileId)),
        );
        const filesByCollectionId = new Map<string, DownloadFileRow[]>();
        const fileByCollectionRemoteId = new Map<string, DownloadFileRow>();
        for (const file of this.repository.listBundleFiles(bundle.id)) {
            const files = filesByCollectionId.get(file.collectionId);
            if (files) files.push(file);
            else filesByCollectionId.set(file.collectionId, [file]);
            fileByCollectionRemoteId.set(`${file.collectionId}\0${file.remoteId}`, file);
        }
        const coordinator = this.reassemblyCoordinators.get(bundle.id);
        const managedSplitPaths = coordinator?.getManagedSplitPaths() ?? new Set<string>();

        try {
            // Wait for any in-flight incremental reassembly to finish before
            // touching the bundle temp dir, so the coordinator's .part files
            // are not deleted mid-append.
            if (coordinator) {
                await coordinator.whenIdle();
            }

            for (const splitFile of manifest.splitFiles) {
                if (manifest.selectedPaths && !manifest.selectedPaths.includes(splitFile.path)) {
                    continue;
                }
                if (managedSplitPaths.has(splitFile.path)) continue;
                const pieces = splitFile.pieces.toSorted(
                    (left, right) => left.offset - right.offset,
                );
                const selected = pieces.every((piece) => {
                    const collection = collectionByOrdinal.get(piece.sourceIndex);
                    if (!collection) return false;
                    return (
                        fileByCollectionRemoteId.get(`${collection.id}\0${piece.remoteFileId}`)
                            ?.selected === 1
                    );
                });
                if (!selected) continue;

                const safePath = this.kd.lib.fs.getSafeRelativePath(splitFile.path, {
                    asciiFilenames: collections[0]?.asciiFilenames === 1,
                });
                const finalPath = path.join(bundle.savePath, safePath);
                const partPath = path.join(
                    bundle.savePath,
                    getBundleTempDirName(bundle.id),
                    "reassembled",
                    `${safePath}.part`,
                );
                await reassembleExtendedFile({
                    pieces: pieces.map((piece) => {
                        const collection = collectionByOrdinal.get(piece.sourceIndex);
                        const file = collection
                            ? fileByCollectionRemoteId.get(
                                  `${collection.id}\0${piece.remoteFileId}`,
                              )
                            : undefined;
                        if (!collection || !file) {
                            throw new Error(`분할 파일 조각을 찾을 수 없습니다: ${splitFile.path}`);
                        }
                        return {
                            path: path.join(
                                collection.savePath,
                                this.kd.lib.fs.getSafeRelativePath(file.path, {
                                    asciiFilenames: collection.asciiFilenames === 1,
                                }),
                            ),
                            offset: piece.offset,
                            size: piece.length,
                            sourceOffset: piece.remoteOffset ?? 0,
                        };
                    }),
                    partPath,
                    finalPath,
                    expectedSize: splitFile.size,
                    expectedSha256: splitFile.sha256,
                });
            }

            for (const collection of collections) {
                for (const file of filesByCollectionId.get(collection.id) ?? []) {
                    if (file.selected !== 1 || splitRemoteIds.has(file.remoteId)) continue;
                    const relativePath = this.kd.lib.fs.getSafeRelativePath(
                        toDisplayPath(file.path, manifest.renames),
                        {
                            asciiFilenames: collection.asciiFilenames === 1,
                        },
                    );
                    const sourcePath = path.join(
                        collection.savePath,
                        this.kd.lib.fs.getSafeRelativePath(file.path, {
                            asciiFilenames: collection.asciiFilenames === 1,
                        }),
                    );
                    const finalPath = path.join(bundle.savePath, relativePath);
                    if (!(await fse.pathExists(sourcePath))) {
                        const finalStat = await fse.stat(finalPath).catch(() => null);
                        if (finalStat?.size === file.size) continue;
                        throw new Error(`완료된 파일을 찾을 수 없습니다: ${file.path}`);
                    }
                    await fse.ensureDir(path.dirname(finalPath));
                    await fse.move(sourcePath, finalPath, { overwrite: true });
                }
            }
            await fse.remove(path.join(bundle.savePath, getBundleTempDirName(bundle.id)));
            this.repository.markBundleStatus(bundle.id, "completed");
        } catch (error) {
            this.repository.markBundleStatus(
                bundle.id,
                "error",
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private listLogicalBundleFiles(bundleId: string, fileId: string) {
        const target = this.repository.getFile(fileId.split("::extended::", 1)[0]);
        if (!target) return [];
        const bundle = this.repository.getBundle(bundleId);
        if (!bundle) return [];
        const manifest = this.parseStoredManifest(bundleId, bundle.manifestJson);
        if (!manifest) return [];
        const split = manifest.splitFiles.find((file) =>
            file.pieces.some((piece) => piece.remoteFileId === target.remoteId),
        );
        const splitIds = split ? new Set(split.pieces.map((piece) => piece.remoteFileId)) : null;
        return this.repository
            .listBundleCollections(bundle.id)
            .flatMap((collection) => this.repository.listFiles(collection.id))
            .filter((file) => (splitIds ? splitIds.has(file.remoteId) : file.path === target.path));
    }
}

function requestPoolProviderId(provider: DownloadProvider | undefined) {
    if (provider === "transfer") {
        return "transfer-it-download" satisfies TransferProviderRequestId;
    }
    if (provider === "workupload") {
        return "workupload-download" satisfies TransferProviderRequestId;
    }
    return "kiosk-download" satisfies TransferProviderRequestId;
}

function tryParseWorkuploadFileSourceMeta(raw: string | null) {
    try {
        return parseWorkuploadFileSourceMeta(raw);
    } catch {
        return null;
    }
}

function validateDraftTreeMutation(
    tree: Collection["tree"],
    selectedPaths: string[],
    renames: Record<string, string>,
) {
    const originalPaths = new Set<string>();
    const collectOriginalPaths = (dir: Collection["tree"], prefix: string) => {
        for (const entry of dir.entries) {
            const originalPath = prefix ? `${prefix}/${entry.node.name}` : entry.node.name;
            originalPaths.add(originalPath);
            if (entry.kind === "dir") {
                collectOriginalPaths(entry.node as Collection["tree"], originalPath);
            } else if (entry.kind === "zip" && (entry.node as ZipNode).entries) {
                const zip = entry.node as ZipNode;
                collectOriginalPaths(
                    { type: "dir", id: zip.id, name: "", entries: zip.entries ?? [] },
                    originalPath,
                );
            }
        }
    };
    collectOriginalPaths(tree, "");

    for (const [originalPath, name] of Object.entries(renames)) {
        if (!originalPaths.has(originalPath)) {
            throw new Error(`Rename target is not part of the prepared draft: ${originalPath}`);
        }
        const error = validateNodeName(name);
        if (error) {
            throw new Error(error);
        }
    }

    const renamed = applyRenamesToTree(tree, renames);
    const selectablePaths = new Set<string>();
    const validateRenamedTree = (dir: Collection["tree"], prefix: string) => {
        const siblingNames = new Set<string>();
        for (const entry of dir.entries) {
            const key = entry.node.name.toLowerCase();
            if (siblingNames.has(key)) {
                throw new Error(`Renamed entries collide in ${prefix || "the collection root"}.`);
            }
            siblingNames.add(key);
            const displayPath = prefix ? `${prefix}/${entry.node.name}` : entry.node.name;
            selectablePaths.add(displayPath);
            if (entry.kind === "dir") {
                validateRenamedTree(entry.node as Collection["tree"], displayPath);
            } else if (entry.kind === "zip" && (entry.node as ZipNode).entries) {
                const zip = entry.node as ZipNode;
                validateRenamedTree(
                    { type: "dir", id: zip.id, name: "", entries: zip.entries ?? [] },
                    displayPath,
                );
            }
        }
    };
    validateRenamedTree(renamed, "");

    if (selectedPaths.length === 0) {
        throw new Error("No files selected.");
    }
    for (const selectedPath of selectedPaths) {
        if (!selectablePaths.has(selectedPath)) {
            throw new Error(`Selected path is not part of the prepared draft: ${selectedPath}`);
        }
    }
    return renamed;
}

function flattenRemoteFiles(
    dir: Collection["tree"],
    prefix: string[] = [],
): Array<{ remoteId: string; path: string; name: string; size: number }> {
    return dir.entries.flatMap((entry) => {
        if (entry.kind === "dir") {
            return flattenRemoteFiles(entry.node as Collection["tree"], [
                ...prefix,
                entry.node.name,
            ]);
        }
        const node = entry.node as { id: string; name: string; size: number };
        return [
            {
                remoteId: node.id,
                path: [...prefix, node.name].join("/"),
                name: node.name,
                size: node.size,
            },
        ];
    });
}
