import type {
    ChunkDownloadStatus,
    Collection,
    DownloadProvider,
    DownloadStatus,
    FileDownloadStatus,
} from "@shared/types";

export type LoadedKioskCollection = {
    provider: "kiosk";
    collection: Collection;
    cat: string;
    rootId: string;
    passwordProtected: boolean;
};

export type LoadedTransferCollection = {
    provider: "transfer";
    collection: Collection;
    rootId: string;
    passwordProtected: boolean;
    authPw?: string;
    nodeKeys: Map<string, string>;
};

export type LoadedCollection = LoadedKioskCollection | LoadedTransferCollection;

export type SegmentDescriptor = {
    type: "cdn" | "edge";
    data: Map<string, unknown>;
};

export type FlatTreeFile = {
    remoteId: string;
    path: string;
    name: string;
    size: number;
    sourceKind: "file" | "zip_entry";
    zipEntryJson: string | null;
    sourceMetaJson?: string | null;
    selected?: boolean;
};

export type DownloadCollectionRow = {
    id: string;
    shareId: string;
    sourceUrl: string;
    passwordPlain: string | null;
    name: string;
    rootId: string;
    segmentSize: number;
    expires: number;
    treeJson: string;
    savePath: string;
    status: DownloadStatus;
    createdAt: string;
    updatedAt: string;
    elapsedMs: number;
    error: string | null;
    asciiFilenames: number;
    provider: DownloadProvider;
};

export type DownloadFileRow = {
    id: string;
    collectionId: string;
    remoteId: string;
    path: string;
    name: string;
    size: number;
    selected: number;
    status: FileDownloadStatus;
    downloadedBytes: number;
    pausedByUser: number;
    createdAt: string;
    updatedAt: string;
    error: string | null;
    sourceKind: "file" | "zip_entry";
    zipEntryJson: string | null;
    sourceMetaJson: string | null;
    completedElsewhere: number;
};

export type DownloadChunkRow = {
    collectionId: string;
    fileId: string;
    chunkIndex: number;
    offset: number;
    size: number;
    status: ChunkDownloadStatus;
    downloadedBytes: number;
    attempts: number;
    updatedAt: string;
    error: string | null;
};

export type CreateDownloadRecord = {
    loaded: LoadedCollection;
    url: string;
    password?: string;
    savePath: string;
    selectedPaths: string[];
    asciiFilenames: boolean;
    zipPasswords?: Record<string, string>;
};

export type TransferFileSourceMeta = {
    nodeKey: string;
};

export type ZipEntryStoredMeta = {
    path: string;
    offset: number;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number;
    encrypted: boolean;
    archiveSize: number;
    password?: string;
    /** Absolute offset of compressed payload; from local header only (not CD). */
    dataOffset?: number;
};

export type ZipEntrySegmentRange = {
    segmentIndex: number;
    localStart: number;
    localEnd: number;
};

export type SegmentDownloadMode = "full-segment" | "byte-range";

export type SchedulerSettings = {
    segmentPoolSize: number;
    maxChunkRetries: number;
    streamWriteBatchBytes: number;
    inflateBufferBytes: number;
};
