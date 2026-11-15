import os from "node:os";
import path from "node:path";

import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
    ZIP_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import type { TreeEntry, ZipNode } from "@shared/types";
import fse from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";
import type { LoadedCollection } from "./types";

import { DownloadService } from ".";

vi.mock("electron/main", () => ({ app: {} }));
vi.mock("electron", () => ({ shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }));
vi.mock("../util", () => ({ showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }));

const URL = `https://kio.ac/c/${"a".repeat(22)}`;
const SAVE_PATH = path.resolve("downloads");

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
    preparedDrafts: Map<string, { id: string; loaded: LoadedCollection }>;
    repository: {
        insertDownload: ReturnType<typeof vi.fn>;
        listUnfinishedFileTargets: ReturnType<typeof vi.fn>;
    };
    scheduler: {
        schedule: ReturnType<typeof vi.fn>;
        resumeCollection: ReturnType<typeof vi.fn>;
    };
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
                if (key === "transfer.startTransfersPaused") return false;
                throw new Error(`Unexpected setting: ${key}`);
            }),
            getDownloadSavePath: vi.fn(async () => SAVE_PATH),
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
                getSafeRelativePath: vi.fn((value: string) => value),
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
    it.each([
        ["report.bin", "report.bin", "report (1).bin", false],
        ["report.bin", "report.bin.part", "report.bin (1).part", false],
        ["report.bin.part", "report.bin", "report (1).bin", false],
        ["folder/../REPORT.BIN", "report.bin.part", "report.bin (1).part", false],
        ["report.bin.part", "REPORT.bin", "REPORT (1).bin", false],
        ["report.bin.part.crc", "report.bin", "report (1).bin", false],
        ["report.bin", "report.bin.part.crc", "report.bin.part (1).crc", false],
        ["report.bin.part.z", "report.bin", "report (1).bin", false],
        ["report.bin", "report.bin.part.z", "report.bin.part (1).z", false],
        ["report.bin.part.z.crc", "report.bin", "report (1).bin", false],
        ["report.bin", "report.bin.part.z.crc", "report.bin.part.z (1).crc", false],
        ["report.bin", "report.bin", "report (1).bin", true],
        ["report.bin.part", "report.bin", "report (1).bin", true],
        ["report.bin.part.crc", "report.bin", "report (1).bin", true],
        ["report.bin.part.z", "report.bin", "report (1).bin", true],
        ["report.bin.part.z.crc", "report.bin", "report (1).bin", true],
        ["other.bin", "report.bin", "report.bin", false],
    ])(
        "avoids download target collisions with %s for %s, selecting %s (on disk: %s)",
        async (existing, name, expected, onDisk) => {
            const savePath = await fse.mkdtemp(path.join(os.tmpdir(), "direct-target-"));
            const { service } = createService();
            try {
                const loaded = loadedCollection();
                vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue({
                    provider: "direct",
                    collection: {
                        ...loaded.collection,
                        provider: "direct",
                        name,
                        tree: {
                            ...loaded.collection.tree,
                            entries: [
                                {
                                    kind: "file",
                                    node: { type: "file", id: "remote", name, size: 1 },
                                },
                            ],
                        },
                    },
                    rootId: "root",
                    passwordProtected: false,
                    fileMeta: { rangeSupported: true },
                });
                const prepared = await service.prepare({ url: "https://example.com/file" });
                if (prepared.status !== "ready") throw new Error("Expected a prepared draft");
                const state = internals(service);
                state.repository.listUnfinishedFileTargets = vi.fn(() =>
                    onDisk ? [] : [{ savePath, path: existing, asciiFilenames: 0 }],
                );
                if (onDisk) await fse.writeFile(path.join(savePath, existing), "existing");
                state.repository.insertDownload = vi.fn(() => "created");
                state.scheduler.schedule = vi.fn(async () => undefined);
                state.emitUpdate = vi.fn(async () => undefined);
                state.getEnrichedItem = vi.fn(() => ({ id: "created" }));

                await service.create({
                    draftId: prepared.draftId,
                    savePath,
                    selectedPaths: [name],
                });

                expect(state.repository.insertDownload).toHaveBeenCalledWith(
                    expect.objectContaining({
                        loaded: expect.objectContaining({
                            collection: expect.objectContaining({
                                name: expected,
                                tree: expect.objectContaining({
                                    entries: [
                                        expect.objectContaining({
                                            node: expect.objectContaining({ name: expected }),
                                        }),
                                    ],
                                }),
                            }),
                        }),
                        selectedPaths: [expected],
                    }),
                );
                if (onDisk)
                    expect(await fse.readFile(path.join(savePath, existing), "utf8")).toBe(
                        "existing",
                    );
            } finally {
                service.destroy();
                await fse.remove(savePath);
            }
        },
    );

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

    it("keeps an in-flight prepare when another URL is prepared", async () => {
        const { service } = createService();
        let firstSignal: AbortSignal | undefined;
        let releaseFirst: () => void = () => undefined;
        const load = vi
            .spyOn(internals(service), "loadCollectionUnlocked")
            .mockImplementationOnce(
                async (payload) =>
                    await new Promise<LoadedCollection>((resolve, reject) => {
                        firstSignal = payload.signal;
                        payload.signal?.addEventListener("abort", () =>
                            reject(payload.signal?.reason),
                        );
                        releaseFirst = () => resolve(loadedCollection());
                    }),
            )
            .mockResolvedValueOnce(loadedCollection());

        const first = service.prepare({ url: URL });
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
        const second = await service.prepare({ url: URL });
        releaseFirst();

        expect(second.status).toBe("ready");
        expect(firstSignal?.aborted).toBe(false);
        await expect(first).resolves.toMatchObject({ status: "ready" });
        expect(internals(service).preparedDrafts.size).toBe(2);
    });

    it("aborts in-flight prepares when every draft is discarded", async () => {
        const { service } = createService();
        let firstSignal: AbortSignal | undefined;
        const load = vi.spyOn(internals(service), "loadCollectionUnlocked").mockImplementationOnce(
            async (payload) =>
                await new Promise<LoadedCollection>((_resolve, reject) => {
                    firstSignal = payload.signal;
                    payload.signal?.addEventListener("abort", () => reject(payload.signal?.reason));
                }),
        );

        const first = service.prepare({ url: URL });
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
        service.discardDraft({});

        expect(firstSignal?.aborted).toBe(true);
        await expect(first).resolves.toMatchObject({ status: "failed" });
        expect(internals(service).preparedDrafts.size).toBe(0);
    });

    it("aborts only the matching in-flight prepare when a correlated draft is discarded", async () => {
        const { service } = createService();
        let firstSignal: AbortSignal | undefined;
        let secondSignal: AbortSignal | undefined;
        let releaseSecond: () => void = () => undefined;
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
            .mockImplementationOnce(
                async (payload) =>
                    await new Promise<LoadedCollection>((resolve, reject) => {
                        secondSignal = payload.signal;
                        payload.signal?.addEventListener("abort", () =>
                            reject(payload.signal?.reason),
                        );
                        releaseSecond = () => resolve(loadedCollection());
                    }),
            );

        const first = service.prepare({ url: URL, correlationId: "item-a" });
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
        const second = service.prepare({ url: URL, correlationId: "item-b" });
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
        service.discardDraft({ draftId: "item-a" });

        expect(firstSignal?.aborted).toBe(true);
        expect(secondSignal?.aborted).toBe(false);
        await expect(first).resolves.toMatchObject({ status: "failed" });
        releaseSecond();
        await expect(second).resolves.toMatchObject({ status: "ready" });
        expect(internals(service).preparedDrafts.size).toBe(1);
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
                savePath: SAVE_PATH,
                selectedPaths: ["a.txt"],
            }),
        ).resolves.toMatchObject({ id: "created" });

        expect(load).toHaveBeenCalledOnce();
        expect(state.repository.insertDownload).toHaveBeenCalledWith(
            expect.objectContaining({ loaded: expect.objectContaining({ provider: "kiosk" }) }),
        );
        expect(state.preparedDrafts.size).toBe(0);
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
            savePath: SAVE_PATH,
            selectedPaths: ["a.txt"],
        });
        await vi.waitFor(() => expect(state.emitUpdate).toHaveBeenCalledTimes(1));
        const replacement = await service.prepare({ url: URL });
        if (replacement.status !== "ready") throw new Error("Expected a replacement draft");
        releaseCreate();
        await expect(creating).resolves.toMatchObject({ id: "created" });

        expect(state.preparedDrafts.get(replacement.draftId)?.id).toBe(replacement.draftId);
        expect(state.preparedDrafts.has(prepared.draftId)).toBe(false);
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
                savePath: SAVE_PATH,
                selectedPaths: ["not-in-draft.txt"],
            }),
        ).rejects.toThrow("not part of the prepared draft");
        await expect(
            service.create({
                draftId: prepared.draftId,
                savePath: SAVE_PATH,
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
                stack: expect.any(String),
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
            zipNodeEntries(
                internals(service).preparedDrafts.get(prepared.draftId)?.loaded.collection.tree
                    .entries[0],
            ),
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
        const firstDraft = internals(service).preparedDrafts.get(prepared.draftId);

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

    it("keeps ZIP entries on the original draft when another draft is prepared", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockImplementation(async () =>
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
        const other = await service.prepare({ url: URL });
        if (other.status !== "ready") throw new Error("Expected a second prepared draft");
        releaseIndexing();

        await expect(pending).resolves.toEqual({ status: "ready", entries: zipEntries() });
        expect(
            zipNodeEntries(
                internals(service).preparedDrafts.get(prepared.draftId)?.loaded.collection.tree
                    .entries[0],
            ),
        ).toEqual(zipEntries());
        expect(
            zipNodeEntries(
                internals(service).preparedDrafts.get(other.draftId)?.loaded.collection.tree
                    .entries[0],
            ),
        ).toBeNull();
    });

    it("keeps completed drafts when another URL is prepared", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedCollection(),
        );
        const first = await service.prepare({ url: URL });
        const second = await service.prepare({ url: URL });
        if (first.status !== "ready" || second.status !== "ready") {
            throw new Error("Expected two prepared drafts");
        }

        expect(internals(service).preparedDrafts.has(first.draftId)).toBe(true);
        expect(internals(service).preparedDrafts.has(second.draftId)).toBe(true);

        service.discardDraft({ draftId: first.draftId });
        expect(internals(service).preparedDrafts.has(first.draftId)).toBe(false);
        expect(internals(service).preparedDrafts.has(second.draftId)).toBe(true);
    });

    it("removes a completed draft when discarded by its correlation id", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedCollection(),
        );
        const first = await service.prepare({ url: URL, correlationId: "item-a" });
        const second = await service.prepare({ url: URL, correlationId: "item-b" });
        if (first.status !== "ready" || second.status !== "ready") {
            throw new Error("Expected two prepared drafts");
        }

        service.discardDraft({ draftId: "item-a" });
        expect(internals(service).preparedDrafts.has(first.draftId)).toBe(false);
        expect(internals(service).preparedDrafts.has(second.draftId)).toBe(true);
    });

    it("clears every draft when discardDraft is called without an id", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedCollection(),
        );
        const first = await service.prepare({ url: URL });
        const second = await service.prepare({ url: URL });
        if (first.status !== "ready" || second.status !== "ready") {
            throw new Error("Expected two prepared drafts");
        }

        service.discardDraft({});
        expect(internals(service).preparedDrafts.size).toBe(0);
    });

    it("keeps extension drafts, prepared or in flight, when the app discards its drafts", async () => {
        const { service } = createService();
        let releasePending: () => void = () => undefined;
        const load = vi
            .spyOn(internals(service), "loadCollectionUnlocked")
            .mockResolvedValueOnce(loadedCollection())
            .mockResolvedValueOnce(loadedCollection())
            .mockImplementationOnce(
                async () =>
                    await new Promise<LoadedCollection>((resolve) => {
                        releasePending = () => resolve(loadedCollection());
                    }),
            );
        const app = await service.prepare({ url: URL });
        const extension = await service.prepare({ url: URL }, "extension");
        const pending = service.prepare({ url: URL }, "extension");
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
        if (app.status !== "ready" || extension.status !== "ready") {
            throw new Error("Expected two prepared drafts");
        }

        service.discardDraft({});
        releasePending();

        const drafts = internals(service).preparedDrafts;
        expect(drafts.has(app.draftId)).toBe(false);
        expect(drafts.has(extension.draftId)).toBe(true);
        await expect(pending).resolves.toMatchObject({ status: "ready" });
    });

    it("does not remove a sibling draft when create finishes", async () => {
        const { service } = createService();
        vi.spyOn(internals(service), "loadCollectionUnlocked").mockResolvedValue(
            loadedCollection(),
        );
        const first = await service.prepare({ url: URL });
        const second = await service.prepare({ url: URL });
        if (first.status !== "ready" || second.status !== "ready") {
            throw new Error("Expected two prepared drafts");
        }
        const state = internals(service);
        state.repository.insertDownload = vi.fn(() => "created");
        state.scheduler.schedule = vi.fn(async () => undefined);
        state.emitUpdate = vi.fn(async () => undefined);
        state.getEnrichedItem = vi.fn(() => ({ id: "created" }));

        await expect(
            service.create({
                draftId: first.draftId,
                savePath: SAVE_PATH,
                selectedPaths: ["a.txt"],
            }),
        ).resolves.toMatchObject({ id: "created" });

        expect(state.preparedDrafts.has(first.draftId)).toBe(false);
        expect(state.preparedDrafts.has(second.draftId)).toBe(true);
    });
});

describe("DownloadService Mega quota auto-resume", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("resumes quota-paused collections when due, only while the setting is on", async () => {
        vi.useFakeTimers({ now: 0 });
        const { service, kd } = createService();
        let enabled = false;
        (kd.setting as unknown as { get: ReturnType<typeof vi.fn> }).get.mockImplementation((async (
            key: string,
        ) => (key === "transfer.megaQuotaAutoResume" ? enabled : false)) as never);
        let paused = [
            {
                id: "mega",
                name: "Mega",
                pauseReasonJson: JSON.stringify({
                    kind: "megaQuota",
                    pausedAt: 0,
                    resumeAt: 60_000,
                }),
            },
        ];
        const resume = vi.fn(() => {
            paused = [];
        });
        (service as unknown as { repository: object }).repository = {
            listMegaQuotaPausedCollections: () => paused,
            resumeCollection: resume,
        };
        const scheduled = vi
            .spyOn(internals(service).scheduler, "resumeCollection")
            .mockImplementation(() => undefined);
        internals(service).emitUpdate = vi.fn(async () => undefined);

        await service.scheduleMegaQuotaResume();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(resume).not.toHaveBeenCalled();

        enabled = true;
        await service.scheduleMegaQuotaResume();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(resume).toHaveBeenCalledExactlyOnceWith("mega", false, { preserveUserPauses: true });
        expect(scheduled).toHaveBeenCalledExactlyOnceWith("mega");
        expect(internals(service).emitUpdate).toHaveBeenCalledExactlyOnceWith("mega");
        service.destroy();
    });

    it("does not resume before the quota wait has passed", async () => {
        vi.useFakeTimers({ now: 0 });
        const { service, kd } = createService();
        (kd.setting as unknown as { get: ReturnType<typeof vi.fn> }).get.mockImplementation(
            (async () => true) as never,
        );
        const resume = vi.fn();
        (service as unknown as { repository: object }).repository = {
            listMegaQuotaPausedCollections: () => [
                {
                    id: "mega",
                    name: "Mega",
                    pauseReasonJson: JSON.stringify({
                        kind: "megaQuota",
                        pausedAt: 0,
                        resumeAt: 60_000,
                    }),
                },
            ],
            resumeCollection: resume,
        };

        await service.scheduleMegaQuotaResume();
        await vi.advanceTimersByTimeAsync(59_000);
        expect(resume).not.toHaveBeenCalled();
        service.destroy();
    });
});
