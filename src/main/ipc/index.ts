import type { IpcEvents } from "@shared/types";
import { BrowserWindow } from "electron";

import type { KioskDownloader } from "../index";

import { registerDownloadHandlers } from "./handlers/download";
import { registerSettingHandlers } from "./handlers/setting";
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
        registerSettingHandlers(this.kd);
        registerUtilHandlers();
        registerWindowHandlers(this.kd);
    }

    public postMessageToWindow<K extends keyof IpcEvents>(
        window: BrowserWindow,
        channel: K,
        ...args: Parameters<IpcEvents[K]>
    ) {
        window.webContents.send(channel, ...args);
    }

    public broadcast<K extends keyof IpcEvents>(channel: K, ...args: Parameters<IpcEvents[K]>) {
        BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send(channel, ...args);
        });
    }
}
