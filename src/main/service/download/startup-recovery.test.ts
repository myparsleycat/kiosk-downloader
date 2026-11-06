import os from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";
import type { DownloadBundleRow, DownloadCollectionRow, DownloadFileRow } from "./types";

import { DownloadService } from ".";
import { getBundleTempDirName } from "./part-file";

vi.mock("electron/main", () => ({ app: {} }));
vi.mock("electron", () => ({ shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }));
vi.mock("../util", () => ({ showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }));

type ServiceInternals = {
    repository: Record<string, unknown>;
    scheduler: Record<string, unknown>;
    reassemblyCoordinators: Map<string, unknown>;
    cleanupOrphanPartFiles: () => Promise<void>;
    finalizeDownloadBundle: (bundleId: string) => Promise<void>;
};

let tempDir: string;

beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), "kd-startup-recovery-"));
});

afterEach(async () => {
    await fse.remove(tempDir);
});

describe("DownloadService startup recovery", () => {
    it("removes only part files of finished files and leaves unrelated .part files alone", async () => {
        const collection = collectionRow({ savePath: tempDir, status: "paused" });
        const { service, db } = createService();
        db.all.mockReturnValue([collection]);
        internals(service).repository = {
            listFiles: vi.fn(() => [
                fileRow({ id: "active", path: "active.bin", status: "paused" }),
                fileRow({ id: "done", path: "done.bin", status: "completed" }),
            ]),
        };
        for (const name of ["active.bin.part", "done.bin.part", "firefox-download.zip.part"]) {
            await fse.writeFile(path.join(tempDir, name), "x");
        }

        await internals(service).cleanupOrphanPartFiles();

        expect((await fse.readdir(tempDir)).toSorted()).toEqual([
            "active.bin.part",
            "firefox-download.zip.part",
        ]);
    });

    it("cleans completed collections but keeps a path another collection is still downloading", async () => {
        const completed = collectionRow({
            id: "completed",
            savePath: tempDir,
            status: "completed",
        });
        const paused = collectionRow({ id: "paused", savePath: tempDir, status: "paused" });
        const { service, db } = createService();
        db.all.mockReturnValue([completed, paused]);
        internals(service).repository = {
            listFiles: vi.fn((collectionId: string) =>
                collectionId === "completed"
                    ? [
                          fileRow({ id: "shared-done", path: "shared.bin", status: "completed" }),
                          fileRow({ id: "zip-done", path: "entry.txt", status: "completed" }),
                      ]
                    : [fileRow({ id: "shared-active", path: "shared.bin", status: "paused" })],
            ),
        };
        for (const name of ["shared.bin.part", "entry.txt.part.z"]) {
            await fse.writeFile(path.join(tempDir, name), "x");
        }

        await internals(service).cleanupOrphanPartFiles();

        expect(await fse.readdir(tempDir)).toEqual(["shared.bin.part"]);
    });

    it("marks the bundle as failed and keeps its temp dir when reassembly did not finish", async () => {
        const bundle = bundleRow({ savePath: tempDir });
        const tempDirPath = path.join(tempDir, getBundleTempDirName(bundle.id));
        await fse.outputFile(path.join(tempDirPath, "piece.bin"), "x");
        const { service } = createService();
        const markBundleStatus = vi.fn();
        internals(service).repository = {
            getBundle: vi.fn(() => bundle),
            listBundleCollections: vi.fn(() => []),
            listBundleFiles: vi.fn(() => []),
            markBundleStatus,
        };
        internals(service).reassemblyCoordinators.set(bundle.id, {
            getManagedSplitPaths: () => new Set(["big.bin"]),
            whenIdle: async () => undefined,
            isComplete: () => false,
        });

        await internals(service).finalizeDownloadBundle(bundle.id);

        expect(markBundleStatus).toHaveBeenCalledWith(bundle.id, "error", expect.any(String));
        expect(markBundleStatus).not.toHaveBeenCalledWith(bundle.id, "completed");
        expect(await fse.pathExists(path.join(tempDirPath, "piece.bin"))).toBe(true);
    });

    it("runs concurrent finalize requests for one bundle only once", async () => {
        const bundle = bundleRow({ savePath: tempDir });
        const { service } = createService();
        const getBundle = vi.fn(() => bundle);
        internals(service).repository = {
            getBundle,
            listBundleCollections: vi.fn(() => []),
            listBundleFiles: vi.fn(() => []),
            markBundleStatus: vi.fn(),
        };

        await Promise.all([
            internals(service).finalizeDownloadBundle(bundle.id),
            internals(service).finalizeDownloadBundle(bundle.id),
        ]);

        expect(getBundle).toHaveBeenCalledTimes(1);
    });
});

describe("DownloadService.remove", () => {
    it("deletes rows and part files only after the collection's runs have settled", async () => {
        const { service } = createService();
        const collection = collectionRow({ savePath: tempDir, status: "downloading" });
        const files = [fileRow({ id: "file-1", path: "a.bin", status: "downloading" })];
        const runsSettled = Promise.withResolvers<void>();
        const deleteCollection = vi.fn();
        const cleanupPartFiles = vi.fn(async () => undefined);
        internals(service).repository = {
            getBundle: vi.fn(() => null),
            getCollection: vi.fn(() => collection),
            listFiles: vi.fn(() => files),
            deleteCollection,
        };
        internals(service).scheduler = {
            removeCollection: vi.fn(() => runsSettled.promise),
            cleanupPartFiles,
        };

        const removal = service.remove(collection.id);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(deleteCollection).not.toHaveBeenCalled();
        expect(cleanupPartFiles).not.toHaveBeenCalled();

        runsSettled.resolve();
        await removal;
        expect(deleteCollection).toHaveBeenCalledWith(collection.id);
        expect(cleanupPartFiles).toHaveBeenCalledWith(collection, files);
    });
});

function createService() {
    const db = { all: vi.fn() };
    const kd = {
        setting: { get: vi.fn() },
        ipc: { sendToMainWindow: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        lib: {
            db,
            fs: { getSafeRelativePath: vi.fn((value: string) => value) },
        },
        service: {
            transfer: {
                onRequestPoolUsageChange: vi.fn(() => () => undefined),
                syncMainWindowProgressBar: vi.fn(),
                refreshPowerSaveBlock: vi.fn(async () => undefined),
            },
        },
    } as unknown as KioskDownloader;
    return { service: new DownloadService(kd), db };
}

function internals(service: DownloadService) {
    return service as unknown as ServiceInternals;
}

function collectionRow(overrides: Partial<DownloadCollectionRow>) {
    return {
        id: "collection-1",
        asciiFilenames: 0,
        ...overrides,
    } as DownloadCollectionRow;
}

function fileRow(overrides: Partial<DownloadFileRow>) {
    return {
        collectionId: "collection-1",
        selected: 1,
        ...overrides,
    } as DownloadFileRow;
}

function bundleRow(overrides: Partial<DownloadBundleRow>): DownloadBundleRow {
    return {
        id: "0123456789abcdef",
        sourceInput: "",
        passwordPlain: null,
        name: "bundle",
        treeJson: "{}",
        manifestJson: JSON.stringify({ renames: {}, splitFiles: [] }),
        savePath: "",
        status: "downloading",
        expires: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        error: null,
        ...overrides,
    };
}
