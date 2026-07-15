import { beforeEach, describe, expect, it, vi } from "vitest";

const autoUpdater = vi.hoisted(() => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const updater = {
        allowDowngrade: true,
        autoInstallOnAppQuit: true,
        disableDifferentialDownload: false,
        autoRunAppAfterInstall: false,
        allowPrerelease: true,
        disableWebInstaller: false,
        forceDevUpdateConfig: false,
        autoDownload: false,
        checkForUpdates: vi.fn(async () => null),
        downloadUpdate: vi.fn(async () => []),
        quitAndInstall: vi.fn(),
        on(event: string, listener: (...args: unknown[]) => void) {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
            return updater;
        },
        emit(event: string, ...args: unknown[]) {
            for (const listener of listeners.get(event) ?? []) {
                listener(...args);
            }
        },
        reset() {
            listeners.clear();
            updater.checkForUpdates.mockClear();
        },
    };
    return updater;
});

vi.mock("node:module", () => ({
    createRequire: () => () => ({ autoUpdater }),
}));

vi.mock("electron", () => ({
    app: {
        isPackaged: true,
        getVersion: vi.fn(() => "1.0.0"),
        removeAllListeners: vi.fn(),
        exit: vi.fn(),
    },
    BrowserWindow: class {
        public static getAllWindows() {
            return [];
        }
    },
}));

vi.mock("@main/lib/isDev", () => ({ default: false }));
vi.mock("@main/lib/isPortable", () => ({ isPortable: () => false }));
vi.mock("./util", () => ({ openExternal: vi.fn(async () => {}) }));

import type { KioskDownloader } from "..";

import { Updater } from "./updater";

function createUpdater() {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const broadcast = vi.fn();
    const kd = {
        setting: { get: vi.fn(async () => "notify") },
        logger,
        ipc: { broadcast, postMessageToWindow: vi.fn() },
        lib: { db: { settings: { getValue: vi.fn(async () => "en") } } },
        window: { main: { window: null, createMainWindow: vi.fn(async () => null) } },
        http: { request: vi.fn() },
    } as unknown as KioskDownloader;
    const updater = new Updater(kd);
    (
        updater as unknown as {
            registerNsisListeners(): void;
        }
    ).registerNsisListeners();
    return { updater, logger, broadcast };
}

describe("Updater NSIS events", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        autoUpdater.reset();
    });

    it("recovers from a malformed update-available payload without an unhandled rejection", async () => {
        const { updater, logger, broadcast } = createUpdater();
        const unhandledRejection = vi.fn();
        process.on("unhandledRejection", unhandledRejection);

        try {
            await updater.checkForUpdates(true);
            expect((await updater.getStatus()).isChecking).toBe(true);

            autoUpdater.emit("update-available", {});

            await vi.waitFor(async () => {
                expect((await updater.getStatus()).isChecking).toBe(false);
            });
            await new Promise<void>((resolve) => setImmediate(resolve));

            expect(unhandledRejection).not.toHaveBeenCalled();
            expect(broadcast).toHaveBeenCalledWith(
                "updater:status-changed",
                expect.objectContaining({ isChecking: false }),
            );
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    event: "update-available",
                    stage: "process-update-info",
                }),
                "updater.updateAvailable",
            );
            expect(logger.error).toHaveBeenCalledWith(expect.any(Error), "updater.updateAvailable");
        } finally {
            process.off("unhandledRejection", unhandledRejection);
        }
    });
});
