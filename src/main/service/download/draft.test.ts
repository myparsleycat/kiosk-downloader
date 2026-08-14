import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
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
});
