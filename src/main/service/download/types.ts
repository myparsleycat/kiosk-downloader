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

export type LoadedWorkuploadCollection = {
    provider: "workupload";
    resource: "file" | "archive";
    collection: Collection;
    rootId: string;
    passwordProtected: boolean;
    fileMetaByRemoteId: Map<string, WorkuploadFileSourceMeta>;
};

export type LoadedCollection =
    | LoadedKioskCollection
    | LoadedTransferCollection
    | LoadedWorkuploadCollection;

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
    bundleId: string | null;
    ordinal: number;
};

export type DownloadBundleRow = {
    id: string;
    sourceInput: string;
    passwordPlain: string | null;
    name: string;
    treeJson: string;
    manifestJson: string;
    savePath: string;
    status: DownloadStatus;
    expires: number;
    createdAt: string;
    updatedAt: string;
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
    bundleId?: string;
    ordinal?: number;
};

export type TransferFileSourceMeta = {
    nodeKey: string;
};

export type WorkuploadFileSourceMeta = {
    originalName: string;
    sha256: string;
    rangeSupported?: boolean;
};

export function parseWorkuploadFileSourceMeta(raw: string | null): WorkuploadFileSourceMeta {
    if (!raw) {
        throw new Error("Missing Workupload file source metadata.");
    }

    let input: unknown;
    try {
        input = JSON.parse(raw);
    } catch {
        throw new Error("Invalid Workupload file source metadata.");
    }

    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("Invalid Workupload file source metadata.");
    }
    const meta = input as Record<string, unknown>;
    if (
        Object.keys(meta).some(
            (key) => key !== "originalName" && key !== "sha256" && key !== "rangeSupported",
        ) ||
        typeof meta.originalName !== "string" ||
        meta.originalName.length === 0 ||
        typeof meta.sha256 !== "string" ||
        !/^[a-f\d]{64}$/i.test(meta.sha256) ||
        (meta.rangeSupported !== undefined && typeof meta.rangeSupported !== "boolean")
    ) {
        throw new Error("Invalid Workupload file source metadata.");
    }

    return {
        originalName: meta.originalName,
        sha256: meta.sha256.toLowerCase(),
        ...(meta.rangeSupported === undefined ? {} : { rangeSupported: meta.rangeSupported }),
    };
}

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
    requestPoolSize: number;
    maxChunkRetries: number;
    streamWriteBatchBytes: number;
    inflateBufferBytes: number;
};
