import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import isDev from "@main/lib/isDev";
import { isPortable } from "@main/lib/isPortable";
import type { AppStatus, PathMetadata } from "@shared/types";
import type { SaveDialogOptions } from "electron";
import {
    BrowserWindow,
    clipboard,
    dialog,
    type MessageBoxOptions,
    type OpenDialogOptions,
    type OpenExternalOptions,
    shell,
} from "electron";
import { app } from "electron/main";
import { trim } from "es-toolkit";
import fse from "fs-extra";

import { kd } from "..";
import { filePathsFromUriList } from "./util-pure";
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

export async function showModal(options: MessageBoxOptions) {
    return dialog.showMessageBox({
        type: options.type,
        title: options.title,
        message: options.message,
    });
}

export async function openExternal(str: string, opt?: OpenExternalOptions) {
    try {
        try {
            const parsedUrl = new URL(str);
            await shell.openExternal(parsedUrl.toString(), opt);
        } catch {
            await shell.openPath(str);
        }
    } catch (error) {
        kd.logger.error(error, `util:openExternal`);
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

export function openPath(path: string) {
    void shell.openPath(path);
}

export async function trash(path: string) {
    await shell.trashItem(path);
    return;
}

export async function mkdir(parentPath: string, name: string): Promise<string> {
    const trimmedName = trim(name);
    if (!trimmedName) {
        throw new Error("INVALID_GROUP_NAME");
    }

    kd.lib.fs.assertValidWindowsFilename(trimmedName);

    const nextPath = path.join(parentPath, trimmedName);
    try {
        await fsp.mkdir(nextPath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        const name = (error as NodeJS.ErrnoException | undefined)?.name;
        if (code === "EEXIST" || name === "AlreadyExists") {
            throw new Error(`ALREADY_EXISTS:${trimmedName}`);
        }
        throw error;
    }

    return nextPath;
}

export function openCmd(path: string) {
    spawn("cmd.exe", ["/c", "start", "cmd.exe"], {
        cwd: path,
        detached: true,
        stdio: "ignore",
    }).unref();
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

export async function getClipboardFiles(): Promise<string[]> {
    const items = await clipboard.read();
    const paths: string[] = [];
    for (const item of items) {
        if (!item.types.includes("text/uri-list")) continue;
        const payload = await item.getType("text/uri-list");
        if (!(payload instanceof Blob)) {
            throw new TypeError("Expected text/uri-list clipboard payload to be a Blob");
        }
        paths.push(...filePathsFromUriList(await payload.text()));
    }
    return paths;
}

export async function getPathMetadata(path: string): Promise<PathMetadata> {
    const stat = await fse.stat(path);
    return {
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        size: stat.size,
        mtime: stat.mtime,
        ctime: stat.ctime,
        birthtime: stat.birthtime,
    };
}

export async function showOpenDialog(options: OpenDialogOptions) {
    return dialog.showOpenDialog(options);
}

export async function showSaveDialog(options: SaveDialogOptions) {
    return dialog.showSaveDialog(options);
}
