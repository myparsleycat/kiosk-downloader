import type { KioskDownloader } from "@main/index";
import { app, Menu, nativeImage, Tray as Tr } from "electron";

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
                              void this.kd.service.updater.checkForUpdates(true).catch((error) => {
                                  this.kd.logger.error(error, "tray.checkForUpdates");
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
}

function createTrayIcon() {
    const image = nativeImage.createFromPath(icon);
    if (process.platform !== "darwin") return image;

    // macOS menu bar: 20×20pt logical size. Do not multiply by scaleFactor.
    return image.resize({ width: 20, height: 20 });
}
