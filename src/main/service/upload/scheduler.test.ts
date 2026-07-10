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
                return new Promise<number>((resolve) => {
                    finishUpload = resolve;
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
        expect(emitProgressUpdate).toHaveBeenCalledWith(COLLECTION_ID, new Set([file.id]));
        expect(emitUpdate).not.toHaveBeenCalled();

        finishUpload?.(file.size);
        await waitForMicrotasks(() => emitUpdate.mock.calls.length === 1);
        expect(api.completeCollection).toHaveBeenCalledTimes(1);
        expect(repository.completeFile).toHaveBeenCalledTimes(1);

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
                return new Promise<number>((resolve) => {
                    finishUpload = resolve;
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
});

function createRepository(files: UploadFileRow[]) {
    const collection = createCollection();
    const completeFile = vi.fn((fileId: string) => {
        const file = files.find((candidate) => candidate.id === fileId);
        if (file) {
            file.status = "completed";
            file.uploadedBytes = file.size;
        }
    });
    const completeUpload = vi.fn();
    const repository = {
        getCollectionElapsedMs: vi.fn(() => 0),
        listRunnableCollections: vi.fn(() => [collection]),
        listCompletedChunkIndexes: vi.fn(() => []),
        getCollection: vi.fn(() => collection),
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
    };
}

function createApi(
    uploadSegment: (
        chunk: ServerFileMapping,
        token: string,
        signal: AbortSignal,
        onProgress?: (bytes: number) => void,
    ) => Promise<number> = vi.fn(async (chunk: ServerFileMapping) => chunk.length),
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
    } as unknown as UploadTransferMetrics;
}

function createKioskDownloader() {
    return {
        setting: {
            transfer: {
                getSegmentPoolSize: vi.fn(async () => 8),
                getUploadMaxChunkRetries: vi.fn(async () => 2),
            },
        },
        service: { transfer: { refreshPowerSaveBlock: vi.fn(async () => undefined) } },
        logger: { error: vi.fn(), warn: vi.fn() },
    } as unknown as KioskDownloader;
}

function createCollection(): UploadCollectionRow {
    return {
        id: COLLECTION_ID,
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
    };
}

function createFile(id: string, remoteIdValue: string): UploadFileRow {
    return {
        id,
        collectionId: COLLECTION_ID,
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

async function waitForMicrotasks(predicate: () => boolean) {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
        await Promise.resolve();
    }
    expect(predicate()).toBe(true);
}
