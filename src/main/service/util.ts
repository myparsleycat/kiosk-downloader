import { spawn } from "node:child_process";

import isDev from "@main/lib/isDev";
import { isPortable } from "@main/lib/isPortable";
import type { AppStatus } from "@shared/types";
import type { SaveDialogOptions } from "electron";
import {
    BrowserWindow,
    clipboard,
    dialog,
    type OpenDialogOptions,
    shell,
} from "electron";
import { app } from "electron/main";

import { kd } from "..";
import { logCaughtError } from "../lib/logged-error";
export { processChunked } from "./util-pure";

export function getAppStatus(): AppStatus {
    return {
        version: app.getVersion(),
        isPackaged: app.isPackaged,
        isPortable: isPortable(),
        isDev: isDev,
        platform: process.platform,
    };
}

// Reachable from the renderer and from window.open, so only web URLs are allowed; other
// schemes or bare paths would let page content launch local files or protocol handlers.
export async function openExternal(str: string) {
    const url = URL.parse(str);
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
        kd.logger.warn({ url: str }, "util:openExternal:blocked");
        throw new Error(`Blocked external URL: ${str}`);
    }
    try {
        await shell.openExternal(url.toString());
    } catch (error) {
        logCaughtError(kd.logger, "util:openExternal", { url: str }, error);
        throw error;
    }
}

export function closeAllWindows() {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((window) => {
        window.close();
    });
}

export async function copyStr(str: string) {
    await clipboard.writeText(str);
}

export function shutdownSystem() {
    if (!app.isPackaged) {
        kd.logger.info("util:shutdownSystem:skipped-dev");
        return false;
    }
    if (process.platform !== "win32") {
        kd.logger.warn({ platform: process.platform }, "util:shutdownSystem:unsupported");
        return false;
    }
    try {
        spawn("shutdown", ["/s", "/f", "/t", "0"], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        }).unref();
        return true;
    } catch (error) {
        kd.logger.error(error, "util:shutdownSystem");
        return false;
    }
}

export async function showOpenDialog(options: OpenDialogOptions) {
    return dialog.showOpenDialog(options);
}

export async function showSaveDialog(options: SaveDialogOptions) {
    return dialog.showSaveDialog(options);
}
