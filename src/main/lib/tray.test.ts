import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
    dialog: {
        showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    },
    menuTemplate: [] as Electron.MenuItemConstructorOptions[],
}));

vi.mock("electron", () => ({
    app: { quit: vi.fn() },
    dialog: electronMocks.dialog,
    Menu: {
        buildFromTemplate: vi.fn((template: Electron.MenuItemConstructorOptions[]) => {
            electronMocks.menuTemplate = template;
            return {};
        }),
    },
    nativeImage: {
        createFromPath: vi.fn(() => ({ resize: vi.fn() })),
    },
    Tray: class {
        public setToolTip = vi.fn();
        public setContextMenu = vi.fn();
        public on = vi.fn();
    },
}));

vi.mock("../../../resources/icon.png?asset", () => ({ default: "icon.png" }));

import type { KioskDownloader } from "../index";

import { Tray } from "./tray";

function createHarness(status: {
    updateAvailable?: boolean;
    updateDownloaded?: boolean;
    isChecking?: boolean;
}) {
    const updater = {
        getStrategy: vi.fn(() => "nsis"),
        checkForUpdates: vi.fn(async () => {}),
        getStatus: vi.fn(async () => ({
            updateAvailable: false,
            updateDownloaded: false,
            isChecking: false,
            ...status,
        })),
        showUpdateUi: vi.fn(async () => {}),
    };
    const logger = { error: vi.fn() };
    const mainWindow = { isDestroyed: vi.fn(() => false) };
    const kd = {
        service: { updater },
        logger,
        window: { main: { window: mainWindow, focus: vi.fn() } },
    } as unknown as KioskDownloader;

    new Tray(kd).createTray();
    const updateItem = electronMocks.menuTemplate.find((item) => item.label === "업데이트 확인...");
    if (!updateItem?.click) {
        throw new Error("Update tray item was not registered.");
    }

    return { updater, logger, mainWindow, click: updateItem.click };
}

describe("Tray update check", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        electronMocks.menuTemplate = [];
    });

    it("forces a check and reports that the current version is latest", async () => {
        const harness = createHarness({});

        harness.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);

        await vi.waitFor(() => {
            expect(electronMocks.dialog.showMessageBox).toHaveBeenCalledWith(
                harness.mainWindow,
                expect.objectContaining({ type: "info", message: "최신 버전입니다." }),
            );
        });
        expect(harness.updater.checkForUpdates).toHaveBeenCalledWith(true);
        expect(harness.updater.showUpdateUi).not.toHaveBeenCalled();
    });

    it("focuses the existing updater UI for an available update without another dialog", async () => {
        const harness = createHarness({ updateAvailable: true });

        harness.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);

        await vi.waitFor(() => expect(harness.updater.showUpdateUi).toHaveBeenCalledOnce());
        expect(harness.updater.checkForUpdates).toHaveBeenCalledWith(true);
        expect(electronMocks.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    it("reports check failures in an Electron message box", async () => {
        const harness = createHarness({});
        const error = new Error("network unavailable");
        harness.updater.checkForUpdates.mockRejectedValueOnce(error);

        harness.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);

        await vi.waitFor(() => {
            expect(electronMocks.dialog.showMessageBox).toHaveBeenCalledWith(
                harness.mainWindow,
                expect.objectContaining({
                    type: "error",
                    message: "업데이트를 확인하지 못했습니다.",
                    detail: "network unavailable",
                }),
            );
        });
        expect(harness.logger.error).toHaveBeenCalledWith(error, "tray.checkForUpdates");
        expect(harness.updater.showUpdateUi).not.toHaveBeenCalled();
    });
});
