import type { IpcHandlers } from "@shared/types";
import { ipcMain } from "electron";

import { isTrustedIpcSender } from "../window/utils";

export function rh<K extends keyof IpcHandlers>(
    channel: K,
    handler: (
        ...args: Parameters<IpcHandlers[K]>
    ) => ReturnType<IpcHandlers[K]> | Promise<ReturnType<IpcHandlers[K]>>,
) {
    ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedIpcSender(event.senderFrame)) {
            throw new Error(`Untrusted IPC sender for ${channel}`);
        }
        return handler(...(args as Parameters<IpcHandlers[K]>));
    });
}
