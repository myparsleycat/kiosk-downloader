import type {
    DirNode,
    UploadOptions,
    UploadStatus,
    UploadTreeFile,
    FileUploadStatus,
    UploadChunkStatus,
} from "@shared/types";

export const UPLOAD_SEGMENT_SIZE = 16 * 1024 * 1024;

/** Local source file with absolute path — main-process only. */
export type UploadSourceFile = UploadTreeFile & {
    fsPath: string;
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
    files: { path: string; name: string; size: number; fsPath: string; sourceMtimeMs: number }[];
    segmentSize: number;
    tree: DirNode;
};

export type SchedulerSettings = {
    maxWorkers: number;
    maxChunkRetries: number;
};
