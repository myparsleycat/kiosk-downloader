import type {
    ChunkDownloadStatus,
    Collection,
    DownloadStatus,
    FileDownloadStatus,
} from "@shared/types";

export type LoadedCollection = {
    collection: Collection;
    cat: string;
    rootId: string;
    passwordProtected: boolean;
};

export type SegmentDescriptor = {
    type: "cdn" | "edge";
    data: Map<string, unknown>;
};

export type FlatTreeFile = {
    remoteId: string;
    path: string;
    name: string;
    size: number;
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
};

export type SchedulerSettings = {
    segmentPoolSize: number;
    maxChunkRetries: number;
    streamWriteBatchBytes: number;
};
