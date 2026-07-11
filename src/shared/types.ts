// oxlint-disable typescript/no-explicit-any
export type { IpcHandlers } from "./types.gen";

import type { AppSettings, SettingKey } from "./settings";

export interface AppStatus {
    version: string;
    isPackaged: boolean;
    isPortable: boolean;
    isDev: boolean;
    platform: NodeJS.Platform;
}

export interface ProxySettings {
    type: "disabled" | "https" | "socks5";
    host?: string;
    port?: string;
    requiresAuth?: boolean;
    username?: string;
    password?: string;
}

interface ToastData {
    description?: string;
}

export interface TitleBarOverlaySyncOptions {
    symbolColor: string;
}

export interface PathMetadata {
    isDirectory: boolean;
    isFile: boolean;
    size: number;
    mtime: Date;
    ctime: Date;
    birthtime: Date;
}

export interface ZipEntryMeta {
    path: string;
    offset: number;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number;
    encrypted: boolean;
}

export interface FileNode {
    type: "file";
    id: string;
    name: string;
    size: number;
    zipEntry?: ZipEntryMeta;
}

export interface DirNode {
    type: "dir";
    id: string;
    name: string;
    entries: TreeEntry[];
}

export interface ZipNode {
    type: "zip";
    id: string;
    name: string;
    size: number;
    entries: TreeEntry[] | null;
}

export interface TreeEntry {
    kind: "dir" | "file" | "zip";
    node: DirNode | FileNode | ZipNode;
}

export type CollectionTree = DirNode;

export type DownloadProvider = "kiosk" | "transfer";

export interface Collection {
    shareId: string;
    name: string;
    expires: number;
    segmentSize: number;
    passwordProtected: boolean;
    tree: CollectionTree;
    provider?: DownloadProvider;
}

export type DownloadStatus =
    | "queued"
    | "downloading"
    | "inflating"
    | "paused"
    | "completed"
    | "error"
    | "expired";

export type FileDownloadStatus =
    | "pending"
    | "downloading"
    | "inflating"
    | "paused"
    | "completed"
    | "error";

export type ChunkDownloadStatus = "pending" | "downloading" | "completed" | "error";

export interface FileProgress {
    fileId: string;
    path: string;
    status: FileDownloadStatus;
    downloaded: number;
    size: number;
    selected: boolean;
    completedElsewhere?: boolean;
    speedBps?: number;
    error?: string;
}

export interface TransferProgressSummary {
    transferredBytes: number;
    totalBytes: number;
    completedFiles: number;
    totalFiles: number;
}

export interface TransferProgressPatch<TProgress, TStatus> {
    id: string;
    progress: Record<string, TProgress>;
    summary: TransferProgressSummary;
    status: TStatus;
    speedBps: number | null;
    elapsedMs: number;
    updatedAt: number;
}

export interface DownloadItem {
    id: string;
    collection: Collection;
    savePath: string;
    progress: Record<string, FileProgress>;
    summary: TransferProgressSummary;
    status: DownloadStatus;
    speedBps?: number;
    elapsedMs?: number;
    createdAt: number;
    updatedAt: number;
    error?: string;
}

export type DownloadProgressPatch = TransferProgressPatch<FileProgress, DownloadStatus>;

export type DownloadFilter = "all" | "active" | "completed";

export type UploadStatus = "queued" | "uploading" | "paused" | "completed" | "error" | "expired";

export type FileUploadStatus = "pending" | "uploading" | "paused" | "completed" | "error";

export type UploadChunkStatus = "pending" | "uploading" | "completed" | "error";

export const MAX_UPLOAD_FILES = 1000;

/** Absolute filesystem paths stay in main; this is display / selection only. */
export interface UploadTreeFile {
    path: string;
    name: string;
    size: number;
    sourceMtimeMs: number;
}

export interface ExpandPathsResult {
    files: UploadTreeFile[];
    truncated: boolean;
}

export interface UploadOptions {
    name: string;
    description: string;
    password: string;
    expires: number;
}

export interface UploadFileProgress {
    fileId: string;
    path: string;
    status: FileUploadStatus;
    uploaded: number;
    size: number;
    speedBps?: number;
    error?: string;
}

export interface UploadItem {
    id: string;
    name: string;
    description: string;
    passwordProtected: boolean;
    expires: number;
    shareLink: string | null;
    tree: CollectionTree;
    progress: Record<string, UploadFileProgress>;
    summary: TransferProgressSummary;
    status: UploadStatus;
    speedBps?: number;
    elapsedMs?: number;
    createdAt: number;
    updatedAt: number;
    error?: string;
}

export type UploadProgressPatch = TransferProgressPatch<UploadFileProgress, UploadStatus>;

export interface CreateUploadPayload {
    tree: UploadTreeFile[];
    options: UploadOptions;
    turnstileToken: string;
}

export interface LoadCollectionPayload {
    url: string;
    password?: string;
}

export interface ProbeCollectionPayload {
    url: string;
}

export interface ProbeCollectionResult {
    passwordRequired: boolean;
}

export interface CreateDownloadPayload {
    url: string;
    password?: string;
    savePath: string;
    selectedPaths: string[];
    zipPasswords?: Record<string, string>;
}

export interface ListZipEntriesPayload {
    url: string;
    password?: string;
    fileId: string;
    zipPassword?: string;
}

export interface ListZipEntriesResult {
    entries: TreeEntry[];
}

export interface ResumePayload {
    force?: boolean;
}

export const DOWNLOAD_TRANSFER_KIND = "kiosk-download-collection" as const;
export const DOWNLOAD_TRANSFER_VERSION = 1;

export type DownloadTransferFileStatus = "completed" | "pending";

export interface DownloadTransferFile {
    remoteId: string;
    path: string;
    name: string;
    size: number;
    selected: boolean;
    status: DownloadTransferFileStatus;
    completedElsewhere: boolean;
    sourceKind: "file" | "zip_entry";
    zipEntryJson?: string | null;
    sourceMetaJson?: string | null;
}

export interface DownloadTransferCollection {
    shareId: string;
    sourceUrl: string;
    passwordPlain?: string | null;
    name: string;
    rootId: string;
    segmentSize: number;
    expires: number;
    tree: CollectionTree;
    asciiFilenames: boolean;
    provider: DownloadProvider;
}

export interface DownloadTransferPayload {
    version: typeof DOWNLOAD_TRANSFER_VERSION;
    kind: typeof DOWNLOAD_TRANSFER_KIND;
    exportedAt: number;
    collection: DownloadTransferCollection;
    files: DownloadTransferFile[];
}

export interface SettingUpdatePayload<K extends SettingKey = SettingKey> {
    key: K;
    value: AppSettings[K];
}

export type IpcEvents = {
    "window:blur": () => void;
    "window:focus": () => void;
    "fn:toast": (message: string, data?: ToastData) => void;
    "renderer:reload": () => void;
    "download:update": (items: DownloadItem[]) => void;
    "download:item-update": (item: DownloadItem) => void;
    "download:progress-update": (patch: DownloadProgressPatch) => void;
    "upload:update": (items: UploadItem[]) => void;
    "upload:item-update": (item: UploadItem) => void;
    "upload:progress-update": (patch: UploadProgressPatch) => void;
    "setting:update": (payload: SettingUpdatePayload) => void;
};
