import type { KioskDownloader } from "@main/index";
import { toErrorMessage } from "@shared/utils";
import { app, dialog, Menu, nativeImage, Tray as Tr, type MessageBoxOptions } from "electron";

import icon from "../../../resources/icon.png?asset";

export class Tray {
    private kd: KioskDownloader;
    public tray: Tr | null = null;

    constructor(kd: KioskDownloader) {
        this.kd = kd;
    }

    public createTray() {
        this.tray = new Tr(createTrayIcon());
        const canCheckUpdates = this.kd.service.updater.getStrategy() !== "unsupported";
        const contextMenu = Menu.buildFromTemplate([
            ...(canCheckUpdates
                ? [
                      {
                          label: "업데이트 확인...",
                          type: "normal" as const,
                          click: () => {
                              void this.checkForUpdates().catch((error) => {
                                  this.kd.logger.error(error, "tray.showUpdateCheckResult");
                              });
                          },
                      },
                      { type: "separator" as const },
                  ]
                : []),
            {
                label: "Quit",
                type: "normal",
                click: () => {
                    app.quit();
                },
            },
        ]);
        this.tray.setToolTip("Kiosk Desktop");
        this.tray.setContextMenu(contextMenu);
        this.tray.on("click", async () => {
            this.kd.window.main.focus();
        });
    }

    private async checkForUpdates(): Promise<void> {
        try {
            await this.kd.service.updater.checkForUpdates(true);
            const status = await this.kd.service.updater.getStatus();
            if (status.updateAvailable || status.updateDownloaded) {
                await this.kd.service.updater.showUpdateUi();
                return;
            }
            if (status.isChecking) {
                await this.showMessageBox({
                    type: "info",
                    title: "업데이트 확인",
                    message: "업데이트를 확인하고 있습니다.",
                });
                return;
            }

            await this.showMessageBox({
                type: "info",
                title: "업데이트 확인",
                message: "최신 버전입니다.",
            });
        } catch (error) {
            this.kd.logger.error(error, "tray.checkForUpdates");
            await this.showMessageBox({
                type: "error",
                title: "업데이트 확인 실패",
                message: "업데이트를 확인하지 못했습니다.",
                detail: toErrorMessage(error),
            });
        }
    }

    private async showMessageBox(options: MessageBoxOptions): Promise<void> {
        const mainWindow = this.kd.window.main.window;
        if (mainWindow && !mainWindow.isDestroyed()) {
            await dialog.showMessageBox(mainWindow, options);
            return;
        }
        await dialog.showMessageBox(options);
    }
}

function createTrayIcon() {
    const image = nativeImage.createFromPath(icon);
    if (process.platform !== "darwin") return image;

    // macOS menu bar: 20×20pt logical size. Do not multiply by scaleFactor.
    return image.resize({ width: 20, height: 20 });
}
