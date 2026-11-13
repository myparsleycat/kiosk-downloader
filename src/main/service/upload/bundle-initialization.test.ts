import { describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";
import type { PersistedBundlePlan } from "./small-file-pack";
import type { UploadBundleRow } from "./types";

import { UploadService } from ".";

vi.mock("electron", () => ({
    app: { getPath: () => "/tmp" },
    Notification: class {},
    BrowserWindow: class {},
    session: {},
}));
vi.mock("../util", () => ({ copyStr: vi.fn(), showSaveDialog: vi.fn() }));
vi.mock("./preparation-worker?nodeWorker", () => ({ default: vi.fn() }));

type ServiceInternals = {
    repository: Record<string, unknown>;
    scheduler: Record<string, unknown>;
    turnstile: Record<string, unknown>;
    api: Record<string, unknown>;
    emitUpdate: () => Promise<void>;
    emitRemoved: () => Promise<void>;
    cleanupBundlePacks: () => Promise<void>;
    prepareBundleCollectionFiles: () => Promise<unknown[]>;
    initializeBundle: (bundle: UploadBundleRow, plan?: PersistedBundlePlan) => Promise<unknown>;
};

describe("UploadService bundle initialization", () => {
    it.each(["pause", "remove"] as const)(
        "stops at the Turnstile step when %s is requested and leaves the status to it",
        async (action) => {
            const { service, repository, api, solve, bundle, plan } = createFixture();

            const initialization = internals(service).initializeBundle(bundle, plan);
            await vi.waitFor(() => expect(solve).toHaveBeenCalledTimes(1));
            if (action === "pause") await service.pauseUpload(bundle.id);
            else await service.remove(bundle.id);
            await initialization;

            expect(api.createCollection).not.toHaveBeenCalled();
            expect(repository.updateBundleInitialization).not.toHaveBeenCalled();
            expect(repository.queueBundle).not.toHaveBeenCalled();
            if (action === "pause") {
                expect(repository.markBundleStatus).toHaveBeenCalledExactlyOnceWith(
                    bundle.id,
                    "paused",
                );
            } else {
                expect(repository.deleteBundle).toHaveBeenCalledWith(bundle.id);
                expect(repository.markBundleStatus).not.toHaveBeenCalled();
            }
        },
    );

    it("restarts initialization when resume follows a pause that is still cancelling", async () => {
        const { service, repository, solve, bundle, plan } = createFixture();

        void internals(service).initializeBundle(bundle, plan);
        await vi.waitFor(() => expect(solve).toHaveBeenCalledTimes(1));
        const pausing = service.pauseUpload(bundle.id);
        const resuming = service.resumeUpload(bundle.id);
        await pausing;

        await vi.waitFor(() => expect(solve).toHaveBeenCalledTimes(2));
        expect(repository.markBundleStatus).toHaveBeenCalledExactlyOnceWith(bundle.id, "paused");
        expect(repository.markBundleStatus.mock.invocationCallOrder[0]).toBeLessThan(
            solve.mock.invocationCallOrder[1] ?? 0,
        );
        void resuming;
    });
});

function createFixture() {
    const kd = {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        window: { main: { window: null } },
        service: {
            transfer: {
                refreshPowerSaveBlock: vi.fn(async () => undefined),
                onRequestPoolUsageChange: vi.fn(() => () => undefined),
            },
        },
    } as unknown as KioskDownloader;
    const service = new UploadService(kd);
    const bundle = {
        id: "bundle-1",
        name: "Bundle",
        physicalCount: 2,
        initializedCount: 0,
        planJson: JSON.stringify({ collections: [{ files: [] }, { files: [] }] }),
    } as UploadBundleRow;
    const plan = { collections: [{ files: [] }, { files: [] }] } as unknown as PersistedBundlePlan;
    const repository = {
        getBundle: vi.fn(() => bundle),
        hasBundleCollectionOrdinal: vi.fn(() => false),
        listBundleCollections: vi.fn(() => []),
        updateBundleInitialization: vi.fn(),
        queueBundle: vi.fn(),
        markBundleStatus: vi.fn(),
        deleteBundle: vi.fn(),
    };
    // Resolves only through the abort signal, like a solve whose window gets closed.
    const solve = vi.fn(
        (_parent: unknown, _progress: unknown, signal?: AbortSignal) =>
            new Promise<string>((_resolve, reject) => {
                signal?.addEventListener("abort", () =>
                    reject(new Error("보안 인증 창이 닫혔습니다.")),
                );
            }),
    );
    const api = { createCollection: vi.fn() };
    Object.assign(internals(service), {
        repository,
        api,
        scheduler: { schedule: vi.fn(async () => undefined) },
        turnstile: { beginSession: vi.fn(), endSession: vi.fn(), solve },
        emitUpdate: vi.fn(async () => undefined),
        emitRemoved: vi.fn(async () => undefined),
        cleanupBundlePacks: vi.fn(async () => undefined),
        prepareBundleCollectionFiles: vi.fn(async () => []),
    });
    return { service, repository, api, solve, bundle, plan };
}

function internals(service: UploadService) {
    return service as unknown as ServiceInternals;
}
