import { afterEach, describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";
import type { UploadTransferMetrics } from "./metrics";
import type { UploadRepository } from "./repository";
import type { ServerFileMapping, UploadCollectionRow, UploadFileRow } from "./types";

import { KioUploadClient } from "./kio-upload-client";
import { UploadScheduler } from "./scheduler";

const COLLECTION_ID = "collection-1";

afterEach(() => {
    vi.useRealTimers();
});

describe("UploadScheduler", () => {
    it("shares eight workers fairly across upload collections", async () => {
        const firstFiles = Array.from({ length: 9 }, (_, index) =>
            createFile(`first-${index}`, remoteId(index + 1), "collection-1"),
        );
        const secondFiles = Array.from({ length: 9 }, (_, index) =>
            createFile(`second-${index}`, remoteId(index + 100), "collection-2"),
        );
        const repository = createRepository([...firstFiles, ...secondFiles]);
        const api = createApi();
        const emitUpdate = vi.fn(async () => undefined);
        const scheduler = new UploadScheduler(
            createKioskDownloader(),
            api.value,
            repository.value,
            createMetrics(),
            emitUpdate,
            vi.fn(async () => undefined),
        );

        scheduler.registerWorkItems(
            "collection-1",
            firstFiles.map((file) => ({ id: file.id, remoteId: file.remoteId })),
            firstFiles.map((file, index) => createChunk(file, index)),
        );
        scheduler.registerWorkItems(
            "collection-2",
            secondFiles.map((file) => ({ id: file.id, remoteId: file.remoteId })),
            secondFiles.map((file, index) => createChunk(file, index)),
        );
        await scheduler.schedule();

        await vi.waitFor(() => expect(api.uploadSegment).toHaveBeenCalledTimes(18));
        const firstEightPaths = vi
            .mocked(api.uploadSegment)
            .mock.calls.slice(0, 8)
            .map(([chunk]) => chunk.relativePath);
        expect(firstEightPaths.filter((path) => path.startsWith("first-"))).toHaveLength(4);
        expect(firstEightPaths.filter((path) => path.startsWith("second-"))).toHaveLength(4);
        expect(firstEightPaths.slice(0, 2)).toEqual([firstFiles[0].path, secondFiles[0].path]);
        await vi.waitFor(() => expect(emitUpdate).toHaveBeenCalledTimes(2));

        scheduler.destroy();
    });

    it("runs only the upload payload through the global request pool", async () => {
        const file = createFile("file-1", remoteId(1));
        const repository = createRepository([file]);
        const run = vi.fn(async (_request, task: () => Promise<void>) => task());
        const uploadSegment = vi.fn(
            async (
                chunk: ServerFileMapping,
                _token: string,
                _signal: AbortSignal,
                _onProgress?: (bytes: number) => void,
                runPayload?: (task: () => Promise<void>) => Promise<void>,
            ) => {
                await runPayload?.(async () => undefined);
                return { length: chunk.length, outcome: "uploaded" as const };
            },
        );
        const scheduler = new UploadScheduler(
            createKioskDownloader(run),
            createApi(uploadSegment).value,
            repository.value,
            createMetrics(),
            vi.fn(async () => undefined),
            vi.fn(async () => undefined),
        );

        scheduler.registerWorkItems(
            COLLECTION_ID,
            [{ id: file.id, remoteId: file.remoteId }],
            [createChunk(file, 0)],
        );
        await scheduler.schedule();

        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        expect(run).toHaveBeenCalledWith(
            expect.objectContaining({
                collectionId: COLLECTION_ID,
                direction: "upload",
                providerId: "kiosk-upload",
                signal: expect.any(AbortSignal),
            }),
            expect.any(Function),
        );

        scheduler.destroy();
    });

    it("completes each single-chunk file once and emits only one terminal snapshot", async () => {
        const fileCount = 1_000;
        const files = Array.from({ length: fileCount }, (_, index) =>
            createFile(`file-${index}`, remoteId(index)),
        );
        const repository = createRepository(files);
        const api = createApi();
        const emitUpdate = vi.fn(async () => undefined);
        const emitProgressUpdate = vi.fn(async () => undefined);
        const scheduler = new UploadScheduler(
            createKioskDownloader(),
            api.value,
            repository.value,
            createMetrics(),
            emitUpdate,
            emitProgressUpdate,
        );

        scheduler.registerWorkItems(
            COLLECTION_ID,
            files.map((file) => ({ id: file.id, remoteId: file.remoteId })),
            files.map((file, index) => createChunk(file, index)),
        );
        await scheduler.schedule();

        await vi.waitFor(() => expect(emitUpdate).toHaveBeenCalledTimes(1), { timeout: 5_000 });

        expect(repository.completeFile).toHaveBeenCalledTimes(fileCount);
        expect(new Set(repository.completeFile.mock.calls.map(([fileId]) => fileId)).size).toBe(
            fileCount,
        );
        expect(api.completeCollection).toHaveBeenCalledTimes(1);
        expect(repository.completeUpload).toHaveBeenCalledTimes(1);
        expect(emitUpdate).toHaveBeenCalledWith(COLLECTION_ID);
        expect(emitProgressUpdate.mock.calls.length).toBeLessThan(10);

        scheduler.destroy();
    });

    it("batches repeated progress for a file into one update per 500ms tick", async () => {
        vi.useFakeTimers();
        const file = createFile("file-1", remoteId(1));
        const repository = createRepository([file]);
        let reportProgress: ((bytes: number) => void) | undefined;
        let finishUpload: ((bytes: number) => void) | undefined;
        const uploadSegment = vi.fn(
            async (
                _chunk: ServerFileMapping,
                _token: string,
                _signal: AbortSignal,
                onProgress?: (bytes: number) => void,
            ) => {
                reportProgress = onProgress;
                return new Promise<{ length: number; outcome: "uploaded" }>((resolve) => {
                    finishUpload = (bytes) => resolve({ length: bytes, outcome: "uploaded" });
                });
            },
        );
        const api = createApi(uploadSegment);
        const emitUpdate = vi.fn(async () => undefined);
        const emitProgressUpdate = vi.fn(async () => undefined);
        const scheduler = new UploadScheduler(
            createKioskDownloader(),
            api.value,
            repository.value,
            createMetrics(),
            emitUpdate,
            emitProgressUpdate,
        );

        scheduler.registerWorkItems(
            COLLECTION_ID,
            [{ id: file.id, remoteId: file.remoteId }],
            [createChunk(file, 0)],
        );
        await scheduler.schedule();
        await waitForMicrotasks(() => reportProgress !== undefined);

        reportProgress?.(1);
        reportProgress?.(2);
        reportProgress?.(3);
        expect(emitProgressUpdate).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(499);
        expect(emitProgressUpdate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(emitProgressUpdate).toHaveBeenCalledTimes(1);
        expect(emitProgressUpdate).toHaveBeenCalledWith(COLLECTION_ID, new Set([file.id]), false);
        expect(emitUpdate).not.toHaveBeenCalled();

        finishUpload?.(file.size);
        await waitForMicrotasks(() => emitUpdate.mock.calls.length === 1);
        expect(api.completeCollection).toHaveBeenCalledTimes(1);
        expect(repository.completeFile).toHaveBeenCalledTimes(1);

        scheduler.destroy();
    });

    it("does not re-emit progress without new byte updates", async () => {
        vi.useFakeTimers();
        const file = createFile("file-1", remoteId(1));
        const repository = createRepository([file]);
        let reportProgress: ((bytes: number) => void) | undefined;
        let finishUpload: ((bytes: number) => void) | undefined;
        const uploadSegment = vi.fn(
            async (
                _chunk: ServerFileMapping,
                _token: string,
                _signal: AbortSignal,
                onProgress?: (bytes: number) => void,
            ) => {
                reportProgress = onProgress;
                return new Promise<{ length: number; outcome: "uploaded" }>((resolve) => {
                    finishUpload = (bytes) => resolve({ length: bytes, outcome: "uploaded" });
                });
            },
        );
        const api = createApi(uploadSegment);
        const emitUpdate = vi.fn(async () => undefined);
        const emitProgressUpdate = vi.fn(async () => undefined);
        const scheduler = new UploadScheduler(
            createKioskDownloader(),
            api.value,
            repository.value,
            createMetrics(),
            emitUpdate,
            emitProgressUpdate,
        );

        scheduler.registerWorkItems(
            COLLECTION_ID,
            [{ id: file.id, remoteId: file.remoteId }],
            [createChunk(file, 0)],
        );
        await scheduler.schedule();
        await waitForMicrotasks(() => reportProgress !== undefined);

        reportProgress?.(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(emitProgressUpdate).toHaveBeenCalledTimes(1);
        emitProgressUpdate.mockClear();

        await vi.advanceTimersByTimeAsync(2_000);
        expect(emitProgressUpdate).not.toHaveBeenCalled();

        reportProgress?.(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(emitProgressUpdate).toHaveBeenCalledTimes(1);

        finishUpload?.(file.size);
        await waitForMicrotasks(() => emitUpdate.mock.calls.length === 1);
        scheduler.destroy();
    });

    it("stops progress updates immediately while waiting for in-flight pause", async () => {
        vi.useFakeTimers();
        const file = createFile("file-1", remoteId(1));
        const repository = createRepository([file]);
        let reportProgress: ((bytes: number) => void) | undefined;
        let finishUpload: ((bytes: number) => void) | undefined;
        const uploadSegment = vi.fn(
            async (
                _chunk: ServerFileMapping,
                _token: string,
                _signal: AbortSignal,
                onProgress?: (bytes: number) => void,
            ) => {
                reportProgress = onProgress;
                return new Promise<{ length: number; outcome: "uploaded" }>((resolve) => {
                    finishUpload = (bytes) => resolve({ length: bytes, outcome: "uploaded" });
                });
            },
        );
        const api = createApi(uploadSegment);
        const emitUpdate = vi.fn(async () => undefined);
        const emitProgressUpdate = vi.fn(async () => undefined);
        const scheduler = new UploadScheduler(
            createKioskDownloader(),
            api.value,
            repository.value,
            createMetrics(),
            emitUpdate,
            emitProgressUpdate,
        );

        scheduler.registerWorkItems(
            COLLECTION_ID,
            [{ id: file.id, remoteId: file.remoteId }],
            [createChunk(file, 0)],
        );
        await scheduler.schedule();
        await waitForMicrotasks(() => reportProgress !== undefined);

        reportProgress?.(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(emitProgressUpdate).toHaveBeenCalledTimes(1);
        emitProgressUpdate.mockClear();

        const pausePromise = scheduler.pauseCollection(COLLECTION_ID);
        reportProgress?.(2);
        reportProgress?.(3);
        await vi.advanceTimersByTimeAsync(1_500);
        expect(emitProgressUpdate).not.toHaveBeenCalled();

        finishUpload?.(file.size);
        await waitForMicrotasks(() => true);
        await vi.advanceTimersByTimeAsync(20);
        await pausePromise;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(emitProgressUpdate).not.toHaveBeenCalled();

        scheduler.destroy();
    });

    it("sizes workers from active collections instead of retained history", async () => {
        const firstFiles = Array.from({ length: 12 }, (_, index) =>
            createFile(`first-${index}`, remoteId(index + 1), "collection-1"),
        );
        const secondFiles = Array.from({ length: 12 }, (_, index) =>
            createFile(`second-${index}`, remoteId(index + 100), "collection-2"),
        );
        const repository = createRepository(firstFiles);
        const started: string[] = [];
        const gates = new Map<string, ReturnType<typeof deferred>>();
        const uploadSegment = vi.fn(async (chunk: ServerFileMapping) => {
            started.push(chunk.relativePath);
            const gate = deferred();
            gates.set(chunk.relativePath, gate);
            await gate.promise;
            return { length: chunk.length, outcome: "uploaded" as const };
        });
        const scheduler = new UploadScheduler(
            createKioskDownloader(),
            createApi(uploadSegment).value,
            repository.value,
            createMetrics(),
            vi.fn(async () => undefined),
            vi.fn(async () => undefined),
        );

        scheduler.registerWorkItems(
            "collection-1",
            firstFiles.map((file) => ({ id: file.id, remoteId: file.remoteId })),
            firstFiles.map((file, index) => createChunk(file, index)),
        );
        await scheduler.schedule();
        await vi.waitFor(() => expect(started).toHaveLength(8));

        await vi.waitFor(() => {
            for (const file of firstFiles) {
                gates.get(file.path)?.resolve();
            }
            expect(repository.completeUpload).toHaveBeenCalledWith(
                "collection-1",
                expect.any(String),
            );
        });

        repository.addFiles(secondFiles);
        scheduler.registerWorkItems(
            "collection-2",
            secondFiles.map((file) => ({ id: file.id, remoteId: file.remoteId })),
            secondFiles.map((file, index) => createChunk(file, index)),
        );
        await scheduler.schedule();
        await vi.waitFor(() =>
            expect(started.filter((path) => path.startsWith("second-"))).toHaveLength(8),
        );
        expect(started.filter((path) => path.startsWith("second-"))).toHaveLength(8);
        expect(internals(scheduler).targetWorkers).toBe(8);
        expect(internals(scheduler).runningWorkers).toBe(8);

        for (const file of secondFiles) {
            gates.get(file.path)?.resolve();
        }
        scheduler.destroy();
    });

    it("does not inflate the worker target when replacing a worker", async () => {
        const collections = ["collection-1", "collection-2", "collection-3"].map(
            (collectionId, collectionIndex) => ({
                collectionId,
                files: Array.from({ length: 8 }, (_, index) =>
                    createFile(
                        `${collectionId}-${index}`,
                        remoteId(collectionIndex * 100 + index + 1),
                        collectionId,
                    ),
                ),
            }),
        );
        const repository = createRepository(collections.flatMap((collection) => collection.files));
        const gates: Array<ReturnType<typeof deferred>> = [];
        const uploadSegment = vi.fn(async (chunk: ServerFileMapping) => {
            const gate = deferred();
            gates.push(gate);
            await gate.promise;
            return { length: chunk.length, outcome: "uploaded" as const };
        });
        const scheduler = new UploadScheduler(
            createKioskDownloader(),
            createApi(uploadSegment).value,
            repository.value,
            createMetrics(),
            vi.fn(async () => undefined),
            vi.fn(async () => undefined),
        );

        for (const collection of collections) {
            scheduler.registerWorkItems(
                collection.collectionId,
                collection.files.map((file) => ({ id: file.id, remoteId: file.remoteId })),
                collection.files.map((file, index) => createChunk(file, index)),
            );
        }
        await scheduler.schedule();
        await vi.waitFor(() => expect(gates).toHaveLength(10));
        expect(internals(scheduler).targetWorkers).toBe(8);
        expect(internals(scheduler).runningWorkers).toBe(10);

        await scheduler.schedule();
        expect(gates).toHaveLength(10);
        expect(internals(scheduler).targetWorkers).toBe(8);
        expect(internals(scheduler).runningWorkers).toBe(10);

        gates.forEach((gate) => gate.resolve());
        scheduler.destroy();
    });
});

function createRepository(files: UploadFileRow[]) {
    const collections = [...new Set(files.map((file) => file.collectionId))].map((collectionId) =>
        createCollection(collectionId),
    );
    const completeFile = vi.fn((fileId: string) => {
        const file = files.find((candidate) => candidate.id === fileId);
        if (file) {
            file.status = "completed";
            file.uploadedBytes = file.size;
        }
    });
    const completeUpload = vi.fn((collectionId: string) => {
        const collection = collections.find((candidate) => candidate.id === collectionId);
        if (collection) {
            collection.status = "completed";
        }
    });
    const repository = {
        getCollectionElapsedMs: vi.fn(() => 0),
        listRunnableCollections: vi.fn(() =>
            collections.filter((collection) => collection.status !== "completed"),
        ),
        listCompletedChunkIndexes: vi.fn(() => []),
        getCollection: vi.fn(
            (collectionId: string) =>
                collections.find((collection) => collection.id === collectionId) ?? null,
        ),
        getFile: vi.fn((fileId: string) => files.find((file) => file.id === fileId) ?? null),
        markFileStatus: vi.fn(),
        markCollectionStatus: vi.fn(),
        markChunkUploading: vi.fn(),
        markChunkCompleted: vi.fn(),
        markChunkPending: vi.fn(),
        markChunkError: vi.fn(),
        addFileUploadedBytes: vi.fn(),
        completeFile,
        completeUpload,
        addCollectionElapsedMs: vi.fn(),
    };
    return {
        value: repository as unknown as UploadRepository,
        completeFile,
        completeUpload,
        addFiles(nextFiles: UploadFileRow[]) {
            files.push(...nextFiles);
            for (const collectionId of new Set(nextFiles.map((file) => file.collectionId))) {
                if (!collections.some((collection) => collection.id === collectionId)) {
                    collections.push(createCollection(collectionId));
                }
            }
        },
    };
}

function createApi(
    uploadSegment: (
        chunk: ServerFileMapping,
        token: string,
        signal: AbortSignal,
        onProgress?: (bytes: number) => void,
        runPayload?: (task: () => Promise<void>) => Promise<void>,
    ) => Promise<{ length: number; outcome: "exists" | "conflict" | "uploaded" }> = vi.fn(
        async (chunk: ServerFileMapping) => ({
            length: chunk.length,
            outcome: "uploaded" as const,
        }),
    ),
) {
    const completeCollection = vi.fn(async () => undefined);
    return {
        value: { uploadSegment, completeCollection } as unknown as KioUploadClient,
        uploadSegment,
        completeCollection,
    };
}

function createMetrics() {
    return {
        registerFile: vi.fn(),
        setChunkTransferProgress: vi.fn(),
        completeChunk: vi.fn(),
        clearChunk: vi.fn(),
        clearFile: vi.fn(),
        clearCollection: vi.fn(),
        recordSegmentExists: vi.fn(),
        recordSegmentConflict: vi.fn(),
        recordSegmentUploaded: vi.fn(),
        getSegmentDedupSnapshot: vi.fn(() => ({
            existsCount: 0,
            existsBytes: 0,
            conflictCount: 0,
            conflictBytes: 0,
            uploadedCount: 0,
            uploadedBytes: 0,
        })),
    } as unknown as UploadTransferMetrics;
}

function createKioskDownloader(
    requestPoolRun = vi.fn(async (_request, task: () => Promise<void>) => task()),
) {
    return {
        setting: {
            get: vi.fn(async (key: string) => {
                if (key === "transfer.uploadMaxChunkRetries") {
                    return 2;
                }
                throw new Error(`Unexpected setting get: ${key}`);
            }),
        },
        service: {
            transfer: {
                requestPool: { runPayload: requestPoolRun },
                refreshPowerSaveBlock: vi.fn(async () => undefined),
                maybeShutdownAfterTransfer: vi.fn(async () => undefined),
            },
        },
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as unknown as KioskDownloader;
}

function createCollection(collectionId = COLLECTION_ID): UploadCollectionRow {
    return {
        id: collectionId,
        name: "collection",
        description: "",
        passwordPlain: null,
        shareId: null,
        shareLink: null,
        collectionUuid: "00112233445566778899aabbccddeeff",
        uploadToken: "token",
        treeJson: "{}",
        segmentSize: 16 * 1024 * 1024,
        expires: 1,
        status: "queued",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        elapsedMs: 0,
        error: null,
        bundleId: null,
        ordinal: 0,
        superseded: 0,
    };
}

function createFile(
    id: string,
    remoteIdValue: string,
    collectionId = COLLECTION_ID,
): UploadFileRow {
    return {
        id,
        collectionId,
        remoteId: remoteIdValue,
        path: `${id}.txt`,
        name: `${id}.txt`,
        size: 4,
        fsPath: `/tmp/${id}.txt`,
        sourceMtimeMs: 1,
        status: "pending",
        uploadedBytes: 0,
        pausedByUser: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        error: null,
        logicalPath: null,
        sourceOffset: 0,
        logicalSize: null,
        logicalSha256: null,
    };
}

function createChunk(file: UploadFileRow, index: number): ServerFileMapping {
    return {
        fileId: Buffer.from(file.remoteId, "hex"),
        relativePath: file.path,
        size: file.size,
        offset: 0,
        sequence: 0,
        length: file.size,
        fsPath: file.fsPath,
        sourceMtimeMs: file.sourceMtimeMs + index,
    };
}

function remoteId(index: number) {
    return index.toString(16).padStart(32, "0");
}

function internals(scheduler: UploadScheduler) {
    return scheduler as unknown as {
        targetWorkers: number;
        runningWorkers: number;
    };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return { promise, resolve };
}

async function waitForMicrotasks(predicate: () => boolean) {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
        await Promise.resolve();
    }
    expect(predicate()).toBe(true);
}
