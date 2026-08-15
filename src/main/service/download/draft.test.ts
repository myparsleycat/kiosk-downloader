import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
    ZIP_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import type { TreeEntry, ZipNode } from "@shared/types";
import { describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";
import type { LoadedCollection } from "./types";

import { DownloadService } from ".";

vi.mock("electron/main", () => ({ app: {} }));
vi.mock("electron", () => ({ shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }));
vi.mock("../util", () => ({ showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }));

const URL = `https://kio.ac/c/${"a".repeat(22)}`;

type DownloadServiceInternals = {
    loadCollectionUnlocked: (
        payload: { url: string; password?: string; signal?: AbortSignal },
        asciiFilenames: boolean,
    ) => Promise<LoadedCollection>;
    indexZipNode: (
        loaded: LoadedCollection,
        remoteFileId: string,
        fileSize: number,
        zipPassword?: string,
    ) => Promise<{ entries: TreeEntry[]; indexed: [] }>;
    preparedDraft: { id: string; loaded: LoadedCollection } | null;
    repository: {
        insertDownload: ReturnType<typeof vi.fn>;
    };
    scheduler: { schedule: ReturnType<typeof vi.fn> };
    emitUpdate: ReturnType<typeof vi.fn>;
    getEnrichedItem: ReturnType<typeof vi.fn>;
};

function loadedCollection(): LoadedCollection {
    return {
        provider: "kiosk",
        collection: {
            shareId: "a".repeat(22),
            name: "Prepared",
            expires: 4_102_444_800,
            segmentSize: 16,
            passwordProtected: false,
            provider: "kiosk",
            tree: {
                type: "dir",
                id: "root",
                name: "",
                entries: [
                    {
                        kind: "file",
                        node: { type: "file", id: "remote", name: "a.txt", size: 1 },
                    },
                ],
            },
        },
        cat: "cat",
        rootId: "root",
        passwordProtected: false,
    };
}

function loadedZipCollection(): LoadedCollection {
    const loaded = loadedCollection();
    return {
        ...loaded,
        collection: {
            ...loaded.collection,
            tree: {
                ...loaded.collection.tree,
                entries: [
                    {
                        kind: "zip",
                        node: {
                            type: "zip",
                            id: "zip-remote",
                            name: "a.zip",
                            size: 10,
                            entries: null,
                        },
                    },
                ],
            },
        },
    };
}

function zipEntries(): TreeEntry[] {
    return [
        {
            kind: "file",
            node: { type: "file", id: "entry", name: "inside.txt", size: 1 },
        },
    ];
}

function zipNodeEntries(entry: TreeEntry | undefined) {
    return entry?.kind === "zip" ? (entry.node as ZipNode).entries : undefined;
}

function createService(passwords: string[] = []) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const kd = {
        setting: {
            get: vi.fn(async (key: string) => {
                if (key === "general.asciiFilenames") return false;
                if (key === "general.createCollectionSubfolder") return false;
                throw new Error(`Unexpected setting: ${key}`);
            }),
            getMany: vi.fn(async () => ({
                "general.autoTryCollectionPasswords": true,
                "general.collectionPasswordList": passwords,
            })),
            set: vi.fn(async () => undefined),
        },
        ipc: { sendToMainWindow: vi.fn() },
        logger,
        lib: {
            db: {},
            fs: {
                sanitizeDownloadPathSegment: vi.fn((value: string) => value),
            },
        },
        service: {
            transfer: {
                syncMainWindowProgressBar: vi.fn(),
                refreshPowerSaveBlock: vi.fn(async () => undefined),
                maybeShutdownAfterTransfer: vi.fn(async () => undefined),
                onRequestPoolUsageChange: vi.fn(() => () => undefined),
            },
        },
    } as unknown as KioskDownloader;
    return { service: new DownloadService(kd), kd, logger };
}

function internals(service: DownloadService) {
    return service as unknown as DownloadServiceInternals;
}

describe("DownloadService prepared draft", () => {
    it("tries automatic password candidates sequentially without logging rejected candidates", async () => {
        const { service, logger } = createService(["wrong", "right"]);
        let active = 0;
        let maxActive = 0;
        const load = vi
            .spyOn(internals(service), "loadCollectionUnlocked")
            .mockImplementation(async (payload) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await Promise.resolve();
                active -= 1;
                if (!payload.password) throw new Error(COLLECTION_PASSWORD_REQUIRED_ERROR);
                if (payload.password === "wrong")
                    throw new Error(COLLECTION_INVALID_PASSWORD_ERROR);
                return loadedCollection();
            });

        const result = await service.prepare({ url: URL });

        expect(result.status).toBe("ready");
        expect(load.mock.calls.map(([payload]) => payload.password)).toEqual([
            undefined,
            "wrong",
            "right",
        ]);
        expect(maxActive).toBe(1);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("aborts the previous prepare when a new URL is prepared", async () => {
        const { service } = createService();
        let firstSignal: AbortSignal | undefined;
        const load = vi
            .spyOn(internals(service), "loadCollectionUnlocked")
            .mockImplementationOnce(
                async (payload) =>
                    await new Promise<LoadedCollection>((_resolve, reject) => {
                        firstSignal = payload.signal;
                        payload.signal?.addEventListener("abort", () =>
                            reject(payload.signal?.reason),
                        );
                    }),
            )
            .mockResolvedValueOnce(loadedCollection());

        const first = service.prepare({ url: URL });
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
        const second = await service.prepare({ url: URL });

        expect(second.status).toBe("ready");
        expect(firstSignal?.aborted).toBe(true);
        await expect(first).resolves.toMatchObject({ status: "failed" });
    });

    it("creates from the canonical snapshot without loading the collection again", async () => {
        const { service } = createService();
        const load = vi
            .spyOn(internals(service), "loadCollectionUnlocked")
            .mockResolvedValue(loadedCollection());
        const prepared = await service.prepare({ url: URL });
        if (prepared.status !== "ready") throw new Error("Expected a prepared draft");
        const state = internals(service);
        state.repository.insertDownload = vi.fn(() => "created");
        state.scheduler.schedule = vi.fn(async () => undefined);
        state.emitUpdate = vi.fn(async () => undefined);
        state.getEnrichedItem = vi.fn(() => ({ id: "created" }));

        await expect(
            service.create({
                draftId: prepared.draftId,
                savePath: "E:\\Downloads",
                selectedPaths: ["a.txt"],
            }),
        ).resolves.toMatchObject({ id: "created" });

        expect(load).toHaveBeenCalledOnce();
        expect(state.repository.insertDownload).toHaveBeenCalledWith(
            expect.objectContaining({ loaded: expect.objectContaining({ provider: "kiosk" }) }),
        );
        expect(state.preparedDraft).toBeNull();
    });

    it("does not clear a replacement draft after create finishes", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedCollection(),
        );
        const prepared = await service.prepare({ url: URL });
        if (prepared.status !== "ready") throw new Error("Expected a prepared draft");
        const state = internals(service);
        let releaseCreate: () => void = () => undefined;
        state.repository.insertDownload = vi.fn(() => "created");
        state.scheduler.schedule = vi.fn(async () => undefined);
        state.emitUpdate = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    releaseCreate = () => resolve();
                }),
        );
        state.getEnrichedItem = vi.fn(() => ({ id: "created" }));

        const creating = service.create({
            draftId: prepared.draftId,
            savePath: "E:\\Downloads",
            selectedPaths: ["a.txt"],
        });
        await vi.waitFor(() => expect(state.emitUpdate).toHaveBeenCalledTimes(1));
        const replacement = await service.prepare({ url: URL });
        if (replacement.status !== "ready") throw new Error("Expected a replacement draft");
        releaseCreate();
        await expect(creating).resolves.toMatchObject({ id: "created" });

        expect(state.preparedDraft?.id).toBe(replacement.draftId);
    });

    it("rejects paths outside the canonical tree and keeps the draft retryable", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedCollection(),
        );
        const prepared = await service.prepare({ url: URL });
        if (prepared.status !== "ready") throw new Error("Expected a prepared draft");
        const state = internals(service);
        state.repository.insertDownload = vi.fn(() => "created");
        state.scheduler.schedule = vi.fn(async () => undefined);
        state.emitUpdate = vi.fn(async () => undefined);
        state.getEnrichedItem = vi.fn(() => ({ id: "created" }));

        await expect(
            service.create({
                draftId: prepared.draftId,
                savePath: "E:\\Downloads",
                selectedPaths: ["not-in-draft.txt"],
            }),
        ).rejects.toThrow("not part of the prepared draft");
        await expect(
            service.create({
                draftId: prepared.draftId,
                savePath: "E:\\Downloads",
                selectedPaths: ["a.txt"],
            }),
        ).resolves.toMatchObject({ id: "created" });
    });

    it("returns a typed stale outcome after the renderer discards its draft", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedCollection(),
        );
        const prepared = await service.prepare({ url: URL });
        if (prepared.status !== "ready") throw new Error("Expected a prepared draft");

        service.discardDraft({ draftId: prepared.draftId });

        await expect(
            service.listZipEntries({ draftId: prepared.draftId, fileId: "remote" }),
        ).resolves.toEqual({
            status: "failed",
            code: "staleDraft",
            message: "Prepared download draft is no longer available.",
        });
    });

    it("sanitizes share URL credentials when prepare fails", async () => {
        const { service, logger } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockRejectedValue(
            new Error("remote down"),
        );

        await expect(
            service.prepare({
                url: `https://user:secret@kio.ac/c/${"a".repeat(22)}?token=sensitive#frag`,
            }),
        ).resolves.toMatchObject({ status: "failed", code: "remoteFailure" });

        expect(logger.error).toHaveBeenCalledWith(
            {
                channel: "download:prepare",
                stage: "load",
                url: `https://kio.ac/c/${"a".repeat(22)}`,
                message: "remote down",
            },
            "DownloadService:prepare",
        );
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret");
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain("token=sensitive");
    });

    it("does not log expected ZIP password challenges", async () => {
        const { service, logger } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedZipCollection(),
        );
        vi.spyOn(internals(service), "indexZipNode").mockRejectedValue(
            new Error(ZIP_PASSWORD_REQUIRED_ERROR),
        );
        const prepared = await service.prepare({ url: URL });
        if (prepared.status !== "ready") throw new Error("Expected a prepared draft");

        await expect(
            service.listZipEntries({ draftId: prepared.draftId, fileId: "zip-remote" }),
        ).resolves.toEqual({ status: "passwordRequired", invalid: false });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("stores ZIP entries on the prepared draft after indexing", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedZipCollection(),
        );
        vi.spyOn(internals(service), "indexZipNode").mockResolvedValue({
            entries: zipEntries(),
            indexed: [],
        });
        const prepared = await service.prepare({ url: URL });
        if (prepared.status !== "ready") throw new Error("Expected a prepared draft");

        await expect(
            service.listZipEntries({ draftId: prepared.draftId, fileId: "zip-remote" }),
        ).resolves.toEqual({ status: "ready", entries: zipEntries() });

        expect(
            zipNodeEntries(internals(service).preparedDraft?.loaded.collection.tree.entries[0]),
        ).toEqual(zipEntries());
    });

    it("returns a typed stale outcome if the draft is discarded while ZIP indexing is in flight", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedZipCollection(),
        );
        let releaseIndexing: () => void = () => undefined;
        const index = vi.spyOn(internals(service), "indexZipNode").mockImplementation(
            () =>
                new Promise((resolve) => {
                    releaseIndexing = () => resolve({ entries: zipEntries(), indexed: [] });
                }),
        );
        const prepared = await service.prepare({ url: URL });
        if (prepared.status !== "ready") throw new Error("Expected a prepared draft");
        const firstDraft = internals(service).preparedDraft;

        const pending = service.listZipEntries({
            draftId: prepared.draftId,
            fileId: "zip-remote",
        });
        await vi.waitFor(() => expect(index).toHaveBeenCalledTimes(1));
        service.discardDraft({ draftId: prepared.draftId });
        releaseIndexing();

        await expect(pending).resolves.toEqual({
            status: "failed",
            code: "staleDraft",
            message: "Prepared download draft is no longer available.",
        });
        expect(zipNodeEntries(firstDraft?.loaded.collection.tree.entries[0])).toBeNull();
    });

    it("does not attach ZIP entries to a replacement draft", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedZipCollection(),
        );
        let releaseIndexing: () => void = () => undefined;
        const index = vi.spyOn(internals(service), "indexZipNode").mockImplementation(
            () =>
                new Promise((resolve) => {
                    releaseIndexing = () => resolve({ entries: zipEntries(), indexed: [] });
                }),
        );
        const prepared = await service.prepare({ url: URL });
        if (prepared.status !== "ready") throw new Error("Expected a prepared draft");

        const pending = service.listZipEntries({
            draftId: prepared.draftId,
            fileId: "zip-remote",
        });
        await vi.waitFor(() => expect(index).toHaveBeenCalledTimes(1));
        const replacement = await service.prepare({ url: URL });
        if (replacement.status !== "ready") throw new Error("Expected a replacement draft");
        releaseIndexing();

        await expect(pending).resolves.toEqual({
            status: "failed",
            code: "staleDraft",
            message: "Prepared download draft is no longer available.",
        });
        expect(internals(service).preparedDraft?.id).toBe(replacement.draftId);
        expect(
            zipNodeEntries(internals(service).preparedDraft?.loaded.collection.tree.entries[0]),
        ).toBeNull();
    });
});
