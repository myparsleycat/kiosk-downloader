// oxlint-disable typescript/no-explicit-any

import { electronAPI } from "@electron-toolkit/preload";
import type { IpcSendChannel } from "@shared/ipc-keys.gen";
import { IPC_EVENT_CHANNELS, IPC_HANDLER_CHANNELS, IPC_SEND_CHANNELS } from "@shared/ipc-keys.gen";
import type { ExpandPathsResult, IpcEvents, IpcHandlers } from "@shared/types";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const ipcHandlerChannelSet = new Set<string>(IPC_HANDLER_CHANNELS);
const ipcSendChannelSet = new Set<string>(IPC_SEND_CHANNELS);
const ipcEventChannelSet = new Set<string>(IPC_EVENT_CHANNELS);

function resolveDroppedPaths(files: File[]): string[] {
    const paths: string[] = [];
    for (const file of files) {
        const fsPath = webUtils.getPathForFile(file);
        if (fsPath) paths.push(fsPath);
    }
    return paths;
}

const api = {
    invoke: <K extends keyof IpcHandlers>(channel: K, ...args: Parameters<IpcHandlers[K]>) => {
        if (!ipcHandlerChannelSet.has(channel)) {
            throw new Error(`Unauthorized IPC channel: ${channel}`);
        }
        return ipcRenderer.invoke(channel, ...args) as Promise<Awaited<ReturnType<IpcHandlers[K]>>>;
    },
    send: <K extends IpcSendChannel>(channel: K, ...args: any[]) => {
        if (!ipcSendChannelSet.has(channel)) {
            throw new Error(`Unauthorized IPC channel: ${channel}`);
        }
        ipcRenderer.send(channel, ...args);
    },
    on: <K extends keyof IpcEvents>(
        channel: K,
        listener: (...args: Parameters<IpcEvents[K]>) => void,
    ) => {
        if (!ipcEventChannelSet.has(channel)) {
            throw new Error(`Unauthorized IPC channel: ${channel}`);
        }
        const subscription = (_event: any, ...args: Parameters<IpcEvents[K]>) => listener(...args);
        ipcRenderer.on(channel, subscription);
        return () => ipcRenderer.removeListener(channel, subscription);
    },
    /** Resolve dropped File handles in preload and expand them in main. Absolute paths never reach the renderer. */
    expandDroppedFiles: (files: File[], maxFiles?: number): Promise<ExpandPathsResult> => {
        const paths = resolveDroppedPaths(files);
        if (paths.length === 0) return Promise.resolve({ files: [], truncated: false });
        return ipcRenderer.invoke(
            "upload:expandPaths",
            paths,
            maxFiles,
        ) as Promise<ExpandPathsResult>;
    },
};

if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld("electron", electronAPI);
        contextBridge.exposeInMainWorld("api", api);
    } catch (error) {
        console.error(error);
    }
} else {
    // @ts-expect-error
    window.electron = electronAPI;
    // @ts-expect-error
    window.api = api;
}
