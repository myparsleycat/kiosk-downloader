import type { UpdaterReleaseNotes, UpdaterStatus } from "@shared/updater";
import { create } from "zustand";

type UpdaterStore = {
    strategy: UpdaterStatus["strategy"];
    mode: UpdaterStatus["mode"];
    updateAvailable: boolean;
    updateDownloaded: boolean;
    releaseVersion: string | null;
    releaseNotes: UpdaterReleaseNotes | null;
    shouldPromptForUpdate: boolean;
    isChecking: boolean;
    isDownloading: boolean;
    appVersion: string | null;
    setShouldPromptForUpdate: (shouldPromptForUpdate: boolean) => void;
    setAppVersion: (appVersion: string | null) => void;
    setUpdaterStatus: (status: UpdaterStatus) => void;
};

export const useUpdaterStore = create<UpdaterStore>((set) => ({
    strategy: "unsupported",
    mode: "auto",
    updateAvailable: false,
    updateDownloaded: false,
    releaseVersion: null,
    releaseNotes: null,
    shouldPromptForUpdate: false,
    isChecking: false,
    isDownloading: false,
    appVersion: null,
    setShouldPromptForUpdate: (shouldPromptForUpdate) => set({ shouldPromptForUpdate }),
    setAppVersion: (appVersion) => set({ appVersion }),
    setUpdaterStatus: (status) =>
        set({
            strategy: status.strategy,
            mode: status.mode,
            updateAvailable: status.updateAvailable,
            updateDownloaded: status.updateDownloaded,
            releaseVersion: status.releaseVersion,
            releaseNotes: status.releaseNotes,
            shouldPromptForUpdate: status.shouldPromptForUpdate,
            isChecking: status.isChecking,
            isDownloading: status.isDownloading,
        }),
}));
