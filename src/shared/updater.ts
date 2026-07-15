export const AUTO_UPDATE_MODES = ["auto", "notify", "off"] as const;
export type AutoUpdateMode = (typeof AUTO_UPDATE_MODES)[number];

export type UpdateStrategy = "nsis" | "manual" | "unsupported";

export type ReleaseNoteTranslationLanguage = "ko" | "ja" | "zh";

export interface UpdaterReleaseNotes {
    original: string | null;
    translated: string | null;
    translatedLanguage: ReleaseNoteTranslationLanguage | null;
}

export interface UpdaterStatus {
    mode: AutoUpdateMode;
    strategy: UpdateStrategy;
    updateAvailable: boolean;
    updateDownloaded: boolean;
    releaseVersion: string | null;
    releaseNotes: UpdaterReleaseNotes | null;
    shouldPromptForUpdate: boolean;
    isChecking: boolean;
    isDownloading: boolean;
}

export const GITHUB_RELEASES_LATEST_URL =
    "https://github.com/myparsleycat/kiosk-downloader/releases/latest";

export const GITHUB_RELEASES_API_URL =
    "https://api.github.com/repos/myparsleycat/kiosk-downloader/releases/latest";
