import { describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";
import type { DownloadCollectionRow, DownloadFileRow, SchedulerSettings } from "./types";

import { DownloadScheduler } from "./scheduler";

type SchedulerInternals = {
    runFile: (
        collectionId: string,
        fileId: string,
        settings: SchedulerSettings,
        controller: AbortController,
    ) => Promise<void>;
};

describe("DownloadScheduler", () => {
    it("keeps excess collections queued until an active file settles", async () => {
        const collections = Array.from({ length: 10 }, (_, index) =>
            createCollection(`collection-${index}`, index),
        );
        const files = collections.map((collection, index) =>
            createFile(`file-${index}`, collection.id),
        );
        const repository = createRepository(collections, files);
        const emitUpdate = vi.fn(async () => undefined);
        const scheduler = new DownloadScheduler(
            createKioskDownloader(),
            {} as never,
            {} as never,
            repository.value,
            createMetrics(),
            emitUpdate,
            vi.fn(async () => undefined),
        );
        const releases = new Map<string, () => void>();
        const controllers = new Map<string, AbortController>();
        const runFile = vi
            .spyOn(scheduler as unknown as SchedulerInternals, "runFile")
            .mockImplementation(async (_collectionId, fileId, _settings, controller) => {
                controllers.set(fileId, controller);
                await new Promise<void>((resolve) => releases.set(fileId, resolve));
            });

        await scheduler.schedule();

        expect(runFile.mock.calls.map(([, fileId]) => fileId)).toEqual(
            files.slice(0, 8).map((file) => file.id),
        );
        expect(
            collections.slice(0, 8).every((collection) => collection.status === "downloading"),
        ).toBe(true);
        expect(collections.slice(8).every((collection) => collection.status === "queued")).toBe(
            true,
        );
        expect([...controllers.values()].every((controller) => !controller.signal.aborted)).toBe(
            true,
        );
        expect(repository.resetRunningChunksForFile).not.toHaveBeenCalled();

        await scheduler.schedule();

        expect(runFile).toHaveBeenCalledTimes(8);
        expect([...controllers.values()].every((controller) => !controller.signal.aborted)).toBe(
            true,
        );

        files[0].status = "completed";
        releases.get(files[0].id)?.();

        await vi.waitFor(() => expect(runFile).toHaveBeenCalledTimes(9));
        expect(runFile.mock.calls[8]?.[1]).toBe(files[8].id);
        expect(collections[8].status).toBe("downloading");
        expect(collections[9].status).toBe("queued");
        expect(repository.resetRunningChunksForFile).not.toHaveBeenCalled();

        scheduler.destroy();
    });
});

function createRepository(collections: DownloadCollectionRow[], files: DownloadFileRow[]) {
    const getCollection = vi.fn(
        (collectionId: string) =>
            collections.find((collection) => collection.id === collectionId) ?? null,
    );
    const getFile = vi.fn((fileId: string) => files.find((file) => file.id === fileId) ?? null);
    const markCollectionStatus = vi.fn(
        (collectionId: string, status: DownloadCollectionRow["status"]) => {
            const collection = getCollection(collectionId);
            if (collection) {
                collection.status = status;
            }
        },
    );
    const resetRunningChunksForFile = vi.fn();
    const repository = {
        getCollectionElapsedMs: vi.fn(() => 0),
        addCollectionElapsedMs: vi.fn(),
        listRunnableCollections: vi.fn(() =>
            collections.filter(
                (collection) =>
                    collection.status === "queued" ||
                    collection.status === "downloading" ||
                    collection.status === "inflating",
            ),
        ),
        hasPendingFile: vi.fn((collectionId: string, excludedFileIds: Iterable<string>) => {
            const excluded = new Set(excludedFileIds);
            return files.some(
                (file) =>
                    file.collectionId === collectionId &&
                    file.status === "pending" &&
                    !excluded.has(file.id),
            );
        }),
        getNextPendingFile: vi.fn(
            (
                collectionId: string,
                _prioritizedFileIds: Iterable<string>,
                excludedFileIds: Iterable<string>,
            ) => {
                const excluded = new Set(excludedFileIds);
                return (
                    files.find(
                        (file) =>
                            file.collectionId === collectionId &&
                            file.status === "pending" &&
                            !excluded.has(file.id),
                    ) ?? null
                );
            },
        ),
        markCollectionStatus,
        getFile,
        getCollection,
        recomputeCollectionStatus: vi.fn((collectionId: string) => {
            const collection = getCollection(collectionId);
            const collectionFiles = files.filter((file) => file.collectionId === collectionId);
            if (collection && collectionFiles.every((file) => file.status === "completed")) {
                collection.status = "completed";
            }
        }),
        resetRunningChunksForFile,
    };
    return {
        value: repository as never,
        resetRunningChunksForFile,
    };
}

function createKioskDownloader() {
    return {
        setting: {
            get: vi.fn(async (key: string) => {
                if (key === "transfer.segmentPoolSize") return 8;
                if (key === "transfer.maxChunkRetries") return 5;
                if (key === "transfer.streamWriteBatchBytes") return 1024 * 1024;
                if (key === "transfer.inflateBufferBytes") return 1024 * 1024;
                throw new Error(`Unexpected setting get: ${key}`);
            }),
        },
        service: {
            transfer: {
                refreshPowerSaveBlock: vi.fn(async () => undefined),
                maybeShutdownAfterTransfer: vi.fn(async () => undefined),
            },
        },
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    } as unknown as KioskDownloader;
}

function createMetrics() {
    return {
        clearFile: vi.fn(),
        clearCollection: vi.fn(),
    } as never;
}

function createCollection(id: string, index: number): DownloadCollectionRow {
    return {
        id,
        shareId: `share-${index}`,
        sourceUrl: `https://example.test/${index}`,
        passwordPlain: null,
        name: id,
        rootId: `root-${index}`,
        segmentSize: 1024,
        expires: Math.floor(Date.now() / 1000) + 3600,
        treeJson: "{}",
        savePath: `/tmp/${id}`,
        status: "queued",
        createdAt: new Date(index * 1000).toISOString(),
        updatedAt: new Date(index * 1000).toISOString(),
        elapsedMs: 0,
        error: null,
        asciiFilenames: 0,
        provider: "kiosk",
    };
}

function createFile(id: string, collectionId: string): DownloadFileRow {
    return {
        id,
        collectionId,
        remoteId: `remote-${id}`,
        path: `${id}.bin`,
        name: `${id}.bin`,
        size: 1024,
        selected: 1,
        status: "pending",
        downloadedBytes: 0,
        pausedByUser: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        error: null,
        sourceKind: "file",
        zipEntryJson: null,
        sourceMetaJson: null,
        completedElsewhere: 0,
    };
}
