import type { IpcEvents } from "@shared/types";
import { BrowserWindow } from "electron";

import type { KioskDownloader } from "../index";

import { registerDownloadHandlers } from "./handlers/download";
import { registerSettingHandlers } from "./handlers/setting";
import { registerUpdaterHandlers } from "./handlers/updater";
import { registerUploadHandlers } from "./handlers/upload";
import { registerUtilHandlers } from "./handlers/util";
import { registerWindowHandlers } from "./handlers/window";

export class IPC {
    private kd: KioskDownloader;

    constructor(kd: KioskDownloader) {
        this.kd = kd;
        this.setupHandlers();
    }

    private setupHandlers() {
        registerDownloadHandlers(this.kd);
        registerUploadHandlers(this.kd);
        registerSettingHandlers(this.kd);
        registerUpdaterHandlers(this.kd);
        registerUtilHandlers();
        registerWindowHandlers(this.kd);
    }

    public postMessageToWindow<K extends keyof IpcEvents>(
        window: BrowserWindow | null,
        channel: K,
        ...args: Parameters<IpcEvents[K]>
    ) {
        if (
            !window ||
            window.isDestroyed() ||
            window.webContents.isDestroyed() ||
            window.webContents.isCrashed() ||
            window.webContents.isLoadingMainFrame()
        ) {
            return;
        }
        try {
            window.webContents.send(channel, ...args);
        } catch (error) {
            if (
                window.isDestroyed() ||
                window.webContents.isDestroyed() ||
                window.webContents.isCrashed() ||
                (error instanceof Error &&
                    error.message.includes(
                        "Render frame was disposed before WebFrameMain could be accessed",
                    ))
            ) {
                return;
            }
            this.kd.logger.error({ channel, error }, "IPC:postMessageToWindow");
        }
    }

    public sendToMainWindow<K extends keyof IpcEvents>(
        channel: K,
        ...args: Parameters<IpcEvents[K]>
    ) {
        this.postMessageToWindow(this.kd.window.main.window, channel, ...args);
    }

    public broadcast<K extends keyof IpcEvents>(channel: K, ...args: Parameters<IpcEvents[K]>) {
        BrowserWindow.getAllWindows().forEach((win) => {
            this.postMessageToWindow(win, channel, ...args);
        });
    }
}
