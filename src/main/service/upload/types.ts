import type {
    DirNode,
    UploadOptions,
    UploadMode,
    UploadStatus,
    UploadTreeFile,
    FileUploadStatus,
    UploadChunkStatus,
} from "@shared/types";

export const UPLOAD_SEGMENT_SIZE = 16 * 1024 * 1024;

/** Local source file with absolute path — main-process only. */
export type UploadSourceFile = UploadTreeFile & {
    fsPath: string;
    sourceOffset?: number;
    logicalPath?: string;
    logicalSize?: number;
    logicalSha256?: string;
};

export type UploadRequestDir = {
    id: Buffer;
    name: string;
    files: UploadRequestFile[];
    children: UploadRequestDir[];
};

export type UploadRequestFile = {
    id: Buffer;
    name: string;
    size: bigint;
};

// Server-assigned tree echoed back by collection/create with new ids.
export type UploadResponseDir = {
    id: unknown;
    name: string;
    files: UploadResponseFile[];
    children: UploadResponseDir[];
};

export type UploadResponseFile = {
    id: unknown;
    name: string;
    size: number;
};

export type CreatedUpload = {
    collectionUuid: Buffer;
    uploadToken: string;
    root: UploadResponseDir;
};

export type ServerFileMapping = {
    fileId: Buffer;
    relativePath: string;
    size: number;
    offset: number;
    sequence: number;
    length: number;
    fsPath: string;
    sourceMtimeMs: number;
    sourceOffset?: number;
    sourceSize?: number;
};

export type UploadBundleRow = {
    id: string;
    mode: Exclude<UploadMode, "standard">;
    name: string;
    description: string;
    passwordPlain: string | null;
    treeJson: string;
    planJson: string;
    physicalCount: number;
    initializedCount: number;
    shareValue: string | null;
    status: UploadStatus;
    expires: number;
    createdAt: string;
    updatedAt: string;
    error: string | null;
};

export type UploadCollectionRow = {
    id: string;
    name: string;
    description: string;
    passwordPlain: string | null;
    shareId: string | null;
    shareLink: string | null;
    collectionUuid: string;
    uploadToken: string;
    treeJson: string;
    segmentSize: number;
    expires: number;
    status: UploadStatus;
    createdAt: string;
    updatedAt: string;
    elapsedMs: number;
    error: string | null;
    bundleId: string | null;
    ordinal: number;
    superseded: number;
};

export type UploadFileRow = {
    id: string;
    collectionId: string;
    remoteId: string;
    path: string;
    name: string;
    size: number;
    fsPath: string;
    sourceMtimeMs: number;
    status: FileUploadStatus;
    uploadedBytes: number;
    pausedByUser: number;
    createdAt: string;
    updatedAt: string;
    error: string | null;
    logicalPath: string | null;
    sourceOffset: number;
    logicalSize: number | null;
    logicalSha256: string | null;
};

export type UploadChunkRow = {
    collectionId: string;
    fileId: string;
    chunkIndex: number;
    offset: number;
    size: number;
    status: UploadChunkStatus;
    uploadedBytes: number;
    attempts: number;
    updatedAt: string;
    error: string | null;
};

export type CreateUploadRecord = {
    created: CreatedUpload;
    options: UploadOptions;
    files: Array<{
        path: string;
        name: string;
        size: number;
        fsPath: string;
        sourceMtimeMs: number;
        logicalPath?: string;
        sourceOffset?: number;
        logicalSize?: number;
        logicalSha256?: string;
    }>;
    segmentSize: number;
    tree: DirNode;
    bundleId?: string;
    ordinal?: number;
};

export type SchedulerSettings = {
    maxWorkers: number;
    maxChunkRetries: number;
};
