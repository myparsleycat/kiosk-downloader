import { tmpdir } from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";
import type {
    DownloadChunkRow,
    DownloadCollectionRow,
    DownloadFileRow,
    SchedulerSettings,
} from "./types";

import { DownloadScheduler } from "./scheduler";

type SchedulerInternals = {
    runFile: (
        collectionId: string,
        fileId: string,
        settings: SchedulerSettings,
        controller: AbortController,
    ) => Promise<void>;
    getWorkuploadSession: (collection: DownloadCollectionRow, fileKey: string) => Promise<unknown>;
    finalizeFile: (
        collection: DownloadCollectionRow,
        file: DownloadFileRow,
        signal?: AbortSignal,
    ) => Promise<void>;
    streamWorkuploadBody: (
        body: ReadableStream<Uint8Array>,
        signal: AbortSignal,
        expectedBytes: number,
        abortRequest?: () => void,
    ) => AsyncGenerator<Uint8Array>;
    persistWorkuploadPartial: (fileId: string, writtenBytes: number) => void;
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

    it("serializes files within each Workupload archive", async () => {
        const collections = [createCollection("archive-a", 0), createCollection("archive-b", 1)];
        for (const collection of collections) collection.provider = "workupload";
        const files = [
            createFile("a-1", collections[0].id),
            createFile("a-2", collections[0].id),
            createFile("b-1", collections[1].id),
        ];
        const repository = createRepository(collections, files);
        const scheduler = new DownloadScheduler(
            createKioskDownloader(),
            {} as never,
            {} as never,
            {} as never,
            repository.value,
            createMetrics(),
            vi.fn(async () => undefined),
            vi.fn(async () => undefined),
        );
        const releases = new Map<string, () => void>();
        const runFile = vi
            .spyOn(scheduler as unknown as SchedulerInternals, "runFile")
            .mockImplementation(
                async (_collectionId, fileId) =>
                    new Promise<void>((resolve) => releases.set(fileId, resolve)),
            );

        await scheduler.schedule();

        expect(runFile.mock.calls.map(([, fileId]) => fileId)).toEqual(["a-1", "b-1"]);

        files[0].status = "completed";
        releases.get("a-1")?.();
        await vi.waitFor(() => expect(runFile).toHaveBeenCalledTimes(3));
        expect(runFile.mock.calls[2]?.[1]).toBe("a-2");

        releases.get("a-2")?.();
        releases.get("b-1")?.();
        scheduler.destroy();
    });

    it("runs Workupload and other providers together within the global limit", async () => {
        const collections = [createCollection("kiosk", 0), createCollection("workupload", 1)];
        collections[1].provider = "workupload";
        const files = [
            createFile("kiosk-file", collections[0].id),
            createFile("workupload-file", collections[1].id),
        ];
        const repository = createRepository(collections, files);
        const scheduler = new DownloadScheduler(
            createKioskDownloader(),
            {} as never,
            {} as never,
            {} as never,
            repository.value,
            createMetrics(),
            vi.fn(async () => undefined),
            vi.fn(async () => undefined),
        );
        const releases = new Map<string, () => void>();
        const runFile = vi
            .spyOn(scheduler as unknown as SchedulerInternals, "runFile")
            .mockImplementation(
                async (_collectionId, fileId) =>
                    new Promise<void>((resolve) => releases.set(fileId, resolve)),
            );

        await scheduler.schedule();

        expect(runFile.mock.calls.map(([, fileId]) => fileId)).toEqual([
            "kiosk-file",
            "workupload-file",
        ]);

        releases.get("kiosk-file")?.();
        releases.get("workupload-file")?.();
        scheduler.destroy();
    });

    it("keeps a published file committed when abort arrives after the move", async () => {
        const directory = await fse.mkdtemp(path.join(tmpdir(), "download-scheduler-"));
        const collection = createCollection("workupload", 0);
        collection.provider = "workupload";
        collection.savePath = directory;
        const file = createFile("file", collection.id);
        file.size = 3;
        const repository = createRepository([collection], [file]);
        const scheduler = new DownloadScheduler(
            createKioskDownloader(),
            {} as never,
            {} as never,
            {} as never,
            repository.value,
            createMetrics(),
            vi.fn(async () => undefined),
            vi.fn(async () => undefined),
        );
        const finalPath = path.join(directory, file.path);
        await fse.outputFile(finalPath, "old");
        await fse.outputFile(`${finalPath}.part`, "new");
        let abortChecks = 0;
        const signal = {
            get aborted() {
                abortChecks += 1;
                return abortChecks > 2;
            },
        } as AbortSignal;

        try {
            await (scheduler as unknown as SchedulerInternals).finalizeFile(
                collection,
                file,
                signal,
            );

            expect(await fse.readFile(finalPath, "utf8")).toBe("new");
            expect(await fse.pathExists(`${finalPath}.part`)).toBe(false);
            expect(repository.completeFile).toHaveBeenCalledWith(file.id);
        } finally {
            scheduler.destroy();
            await fse.remove(directory);
        }
    });

    it("logs Workupload checksum failures with diagnostic context", async () => {
        const collection = createCollection("workupload-checksum", 0);
        collection.provider = "workupload";
        collection.sourceUrl = "https://workupload.com/file/AbCdEf1234";
        const file = createFile("checksum-file", collection.id);
        file.size = 0;
        file.sourceMetaJson = JSON.stringify({
            originalName: file.name,
            sha256: "0".repeat(64),
        });
        const repository = createRepository([collection], [file]);
        const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
        const scheduler = new DownloadScheduler(
            createKioskDownloader(logger),
            {} as never,
            {} as never,
            {} as never,
            repository.value,
            createMetrics(),
            vi.fn(async () => undefined),
            vi.fn(async () => undefined),
        );

        try {
            await (scheduler as unknown as SchedulerInternals).runFile(
                collection.id,
                file.id,
                createSchedulerSettings(0),
                new AbortController(),
            );

            expect(logger.error).toHaveBeenCalledTimes(2);
            expect(logger.error.mock.calls[0]?.[0]).toMatchObject({
                sourceUrl: collection.sourceUrl,
                partPath: `${path.join(collection.savePath, file.path)}.part`,
                finalPath: path.join(collection.savePath, file.path),
                stage: "checksum",
                retryCount: 0,
                rangeSupported: null,
                cleanupState: "not-attempted",
            });
        } finally {
            scheduler.destroy();
        }
    });

    it("logs Workupload finalization failures at the finalization stage", async () => {
        const collection = createCollection("workupload-finalize", 0);
        collection.provider = "workupload";
        const file = createFile("finalize-file", collection.id);
        file.size = 0;
        file.sourceMetaJson = JSON.stringify({
            originalName: file.name,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        });
        const repository = createRepository([collection], [file]);
        const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
        const scheduler = new DownloadScheduler(
            createKioskDownloader(logger),
            {} as never,
            {} as never,
            {} as never,
            repository.value,
            createMetrics(),
            vi.fn(async () => undefined),
            vi.fn(async () => undefined),
        );
        vi.spyOn(scheduler as unknown as SchedulerInternals, "finalizeFile").mockRejectedValue(
            new Error("finalize failed"),
        );

        try {
            await (scheduler as unknown as SchedulerInternals).runFile(
                collection.id,
                file.id,
                createSchedulerSettings(0),
                new AbortController(),
            );

            expect(logger.error.mock.calls[0]?.[0]).toMatchObject({
                stage: "finalize",
                retryCount: 0,
                rangeSupported: null,
                cleanupState: "not-attempted",
            });
        } finally {
            scheduler.destroy();
        }
    });

    it.each([
        { rangeSupported: true, cleanupState: "preserved" },
        { rangeSupported: false, cleanupState: "reset" },
    ] as const)(
        "logs Workupload retry exhaustion with range and cleanup state ($rangeSupported)",
        async ({ rangeSupported, cleanupState }) => {
            const collection = createCollection("workupload-retry", 0);
            collection.provider = "workupload";
            const file = createFile("retry-file", collection.id);
            file.sourceMetaJson = JSON.stringify({
                originalName: file.name,
                sha256: "0".repeat(64),
                rangeSupported,
            });
            const chunk: DownloadChunkRow = {
                collectionId: collection.id,
                fileId: file.id,
                chunkIndex: 0,
                offset: 0,
                size: file.size,
                status: "pending",
                downloadedBytes: 0,
                attempts: 0,
                updatedAt: file.updatedAt,
                error: null,
            };
            const repository = createRepository([collection], [file], [chunk]);
            const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
            const requestDownload = vi.fn(async () => {
                throw new Error("CDN unavailable");
            });
            const scheduler = new DownloadScheduler(
                createKioskDownloader(logger),
                {} as never,
                {} as never,
                { createSession: vi.fn(async () => ({ requestDownload })) } as never,
                repository.value,
                createMetrics(),
                vi.fn(async () => undefined),
                vi.fn(async () => undefined),
            );

            try {
                await (scheduler as unknown as SchedulerInternals).runFile(
                    collection.id,
                    file.id,
                    createSchedulerSettings(0),
                    new AbortController(),
                );

                expect(logger.error.mock.calls[0]?.[0]).toMatchObject({
                    stage: "cdn-request",
                    retryCount: 0,
                    rangeSupported,
                    cleanupState,
                });
            } finally {
                scheduler.destroy();
            }
        },
    );

    it("accepts an exact chunked Workupload body without Content-Length", async () => {
        const scheduler = createSchedulerForStreamTest();
        const body = streamBytes(["ab", "c"]);

        await expect(
            collectBytes(
                (scheduler as unknown as SchedulerInternals).streamWorkuploadBody(
                    body,
                    new AbortController().signal,
                    3,
                ),
            ),
        ).resolves.toBe("abc");

        scheduler.destroy();
    });

    it("rejects extra bytes in a chunked Workupload body without Content-Length", async () => {
        const scheduler = createSchedulerForStreamTest();
        const body = streamBytes(["abc", "d"]);

        await expect(
            collectBytes(
                (scheduler as unknown as SchedulerInternals).streamWorkuploadBody(
                    body,
                    new AbortController().signal,
                    3,
                ),
            ),
        ).rejects.toThrow("more than the expected 3B");

        scheduler.destroy();
    });

    it("aborts a Workupload request when the body stalls", async () => {
        vi.useFakeTimers();
        const scheduler = createSchedulerForStreamTest();
        const reader = {
            read: vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined)),
            cancel: vi.fn(async () => undefined),
            releaseLock: vi.fn(),
        };
        const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
        const abortRequest = vi.fn();

        try {
            const result = collectBytes(
                (scheduler as unknown as SchedulerInternals).streamWorkuploadBody(
                    body,
                    new AbortController().signal,
                    3,
                    abortRequest,
                ),
            );
            const rejected = expect(result).rejects.toThrow("Workupload CDN body stalled.");
            await vi.advanceTimersByTimeAsync(15_000);

            await rejected;
            expect(abortRequest).toHaveBeenCalledOnce();
            expect(reader.cancel).toHaveBeenCalledOnce();
        } finally {
            scheduler.destroy();
            vi.useRealTimers();
        }
    });

    it("keeps an exact Workupload body when the connection stays open after completion", async () => {
        vi.useFakeTimers();
        const scheduler = createSchedulerForStreamTest();
        const reader = {
            read: vi
                .fn()
                .mockResolvedValueOnce({
                    done: false,
                    value: Buffer.from("abc"),
                })
                .mockImplementationOnce(
                    () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
                ),
            cancel: vi.fn(async () => undefined),
            releaseLock: vi.fn(),
        };
        const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
        const abortRequest = vi.fn();

        try {
            const result = collectBytes(
                (scheduler as unknown as SchedulerInternals).streamWorkuploadBody(
                    body,
                    new AbortController().signal,
                    3,
                    abortRequest,
                ),
            );
            const resolved = expect(result).resolves.toBe("abc");
            await vi.advanceTimersByTimeAsync(2_000);

            await resolved;
            expect(abortRequest).toHaveBeenCalledOnce();
            expect(reader.read).toHaveBeenCalledTimes(2);
            expect(reader.cancel).toHaveBeenCalledOnce();
        } finally {
            scheduler.destroy();
            vi.useRealTimers();
        }
    });

    it("persists resumable Workupload bytes before leaving the chunk pending", () => {
        const repository = createRepository([], []);
        const scheduler = new DownloadScheduler(
            createKioskDownloader(),
            {} as never,
            {} as never,
            {} as never,
            repository.value,
            createMetrics(),
            vi.fn(async () => undefined),
            vi.fn(async () => undefined),
        );

        (scheduler as unknown as SchedulerInternals).persistWorkuploadPartial("file", 123);

        expect(repository.markChunkPartial).toHaveBeenCalledWith("file", 0, 123);
        expect(repository.markChunkPending).toHaveBeenCalledWith("file", 0);
        expect(repository.syncWorkuploadDownloadedBytes).toHaveBeenCalledWith("file");
        expect(repository.markChunkPending.mock.invocationCallOrder[0]).toBeLessThan(
            repository.syncWorkuploadDownloadedBytes.mock.invocationCallOrder[0],
        );
        scheduler.destroy();
    });

    it("recreates a Workupload session with the persisted collection password", async () => {
        const collection = createCollection("protected-archive", 0);
        collection.provider = "workupload";
        collection.passwordPlain = "archive-secret";
        const repository = createRepository([collection], []);
        const session = { source: { files: [] } };
        const workuploadApi = {
            createSession: vi.fn(async () => session),
        };
        const scheduler = new DownloadScheduler(
            createKioskDownloader(),
            {} as never,
            {} as never,
            workuploadApi as never,
            repository.value,
            createMetrics(),
            vi.fn(async () => undefined),
            vi.fn(async () => undefined),
        );

        await (scheduler as unknown as SchedulerInternals).getWorkuploadSession(
            collection,
            "ChildOne",
        );

        expect(workuploadApi.createSession).toHaveBeenCalledWith(collection.sourceUrl, {
            requestedFileKey: "ChildOne",
            password: "archive-secret",
        });
        scheduler.destroy();
    });
});

function createRepository(
    collections: DownloadCollectionRow[],
    files: DownloadFileRow[],
    chunks: DownloadChunkRow[] = [],
) {
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
    const ensureCollectionNotExpired = vi.fn(() => false);
    const markFileStatus = vi.fn(
        (fileId: string, status: DownloadFileRow["status"], error?: string | null) => {
            const file = getFile(fileId);
            if (file) {
                file.status = status;
                file.error = error ?? null;
            }
        },
    );
    const listChunks = vi.fn((fileId: string) => chunks.filter((chunk) => chunk.fileId === fileId));
    const markChunkDownloading = vi.fn((chunk: DownloadChunkRow) => {
        chunk.status = "downloading";
    });
    const resetFileProgress = vi.fn((fileId: string) => {
        const file = getFile(fileId);
        if (file) {
            file.downloadedBytes = 0;
        }
    });
    const completeFile = vi.fn();
    const markChunkPending = vi.fn();
    const markChunkPartial = vi.fn();
    const syncWorkuploadDownloadedBytes = vi.fn();
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
        ensureCollectionNotExpired,
        getFile,
        getCollection,
        markFileStatus,
        listChunks,
        markChunkDownloading,
        resetFileProgress,
        recomputeCollectionStatus: vi.fn((collectionId: string) => {
            const collection = getCollection(collectionId);
            const collectionFiles = files.filter((file) => file.collectionId === collectionId);
            if (collection && collectionFiles.every((file) => file.status === "completed")) {
                collection.status = "completed";
            }
        }),
        resetRunningChunksForFile,
        completeFile,
        markChunkPartial,
        markChunkPending,
        syncWorkuploadDownloadedBytes,
    };
    return {
        value: repository as never,
        resetRunningChunksForFile,
        completeFile,
        markChunkPartial,
        markChunkPending,
        syncWorkuploadDownloadedBytes,
    };
}

function createKioskDownloader(logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }) {
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
                downloadBandwidth: { take: vi.fn(async () => undefined) },
                refreshPowerSaveBlock: vi.fn(async () => undefined),
                maybeShutdownAfterTransfer: vi.fn(async () => undefined),
            },
        },
        lib: {
            fs: {
                getSafeRelativePath: vi.fn((filePath: string) => filePath),
            },
        },
        logger,
    } as unknown as KioskDownloader;
}

function createMetrics() {
    return {
        clearFile: vi.fn(),
        clearCollection: vi.fn(),
        registerFile: vi.fn(),
    } as never;
}

function createSchedulerSettings(maxChunkRetries: number): SchedulerSettings {
    return {
        segmentPoolSize: 1,
        maxChunkRetries,
        streamWriteBatchBytes: 1024,
        inflateBufferBytes: 1024,
    };
}

function createSchedulerForStreamTest() {
    return new DownloadScheduler(
        createKioskDownloader(),
        {} as never,
        {} as never,
        {} as never,
        createRepository([], []).value,
        createMetrics(),
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
    );
}

function streamBytes(chunks: string[]) {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(Buffer.from(chunk));
            }
            controller.close();
        },
    });
}

async function collectBytes(source: AsyncIterable<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of source) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
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
        bundleId: null,
        ordinal: index,
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
