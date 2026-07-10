import { ElectronAPI } from "@electron-toolkit/preload";

import type { ExpandPathsResult, IpcEvents, IpcHandlers } from "../shared/types";

import { IpcSendChannel } from "../shared/ipc-keys.gen";

declare global {
    interface Window {
        electron: ElectronAPI;
        api: {
            invoke<T extends keyof IpcHandlers>(
                channel: T,
                ...args: Parameters<IpcHandlers[T]>
            ): Promise<Awaited<ReturnType<IpcHandlers[T]>>>;
            // oxlint-disable-next-line typescript/no-explicit-any
            send(channel: IpcSendChannel, ...args: any[]): void;
            on<T extends keyof IpcEvents>(
                channel: T,
                listener: (...args: Parameters<IpcEvents[T]>) => void,
            ): () => void;
            expandDroppedFiles(files: File[], maxFiles?: number): Promise<ExpandPathsResult>;
        };
    }
}
