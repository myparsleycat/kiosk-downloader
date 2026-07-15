import { createRequire } from "node:module";

import isDev from "@main/lib/isDev";
import { isPortable } from "@main/lib/isPortable";
import {
    type AutoUpdateMode,
    GITHUB_RELEASES_API_URL,
    GITHUB_RELEASES_LATEST_URL,
    type ReleaseNoteTranslationLanguage,
    type UpdateStrategy,
    type UpdaterStatus,
} from "@shared/updater";
import { toErrorMessage } from "@shared/utils";
import { app, BrowserWindow } from "electron";
import { convert as htmlToText } from "html-to-text";
import ms from "ms";
import z from "zod";

import type { KioskDownloader } from "..";

import { openExternal } from "./util";

const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");

autoUpdater.allowDowngrade = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.disableDifferentialDownload = true;
autoUpdater.autoRunAppAfterInstall = true;
autoUpdater.allowPrerelease = false;
autoUpdater.disableWebInstaller = true;
if (isDev) {
    autoUpdater.forceDevUpdateConfig = true;
}

const RELEASE_NOTES_TRANSLATION_URL = "https://api.nahida.live/translate";

const releaseNoteInfoSchema = z.object({
    note: z.string(),
    version: z.string().optional().nullable(),
});

const updateInfoSchema = z.object({
    version: z.string(),
    releaseNotes: z
        .union([z.string(), releaseNoteInfoSchema, z.array(releaseNoteInfoSchema), z.null()])
        .optional(),
});

const translationResponseSchema = z.object({
    response: z.union([
        z.string(),
        z.object({
            choices: z.array(
                z.object({
                    message: z.object({
                        content: z.string().nullable().optional(),
                    }),
                }),
            ),
        }),
    ]),
});

const githubReleaseSchema = z.object({
    tag_name: z.string(),
    body: z.string().nullable().optional(),
});

export class Updater {
    private readonly kd: KioskDownloader;
    public updateDownloaded = false;
    public updateAvailable = false;
    private releaseVersion: string | null = null;
    private originalReleaseNotesText: string | null = null;
    private translatedReleaseNotesText: string | null = null;
    private translatedLanguage: ReleaseNoteTranslationLanguage | null = null;
    private updateDialogDismissed = false;
    private interval: ReturnType<typeof setInterval> | undefined;
    private isCheckingForUpdates = false;
    private isDownloadingUpdate = false;
    private hasRunInitialAutoCheck = false;
    private releaseNotesTranslationRequestId = 0;
    private nsisListenersRegistered = false;

    public constructor(kd: KioskDownloader) {
        this.kd = kd;
    }

    public getStrategy(): UpdateStrategy {
        if (isPortable()) {
            return "unsupported";
        }
        if (!app.isPackaged && !isDev) {
            return "unsupported";
        }
        if (process.platform === "win32") {
            return "nsis";
        }
        if (process.platform === "darwin") {
            return "manual";
        }
        return "unsupported";
    }

    public initialize(): void {
        const strategy = this.getStrategy();
        if (strategy === "unsupported") {
            return;
        }

        if (strategy === "nsis") {
            this.registerNsisListeners();
        }

        clearInterval(this.interval);
        this.interval = setInterval(() => {
            this.runAutomaticCheck().catch((err) => {
                if (isMissingUpdateMetadataError(err)) {
                    this.kd.logger.debug(err, "updater.interval.missingMetadata");
                    return;
                }
                this.kd.logger.error(err, "updater.interval");
            });
        }, ms("1h"));

        void this.runInitialAutomaticCheck();
    }

    private registerNsisListeners(): void {
        if (this.nsisListenersRegistered) {
            return;
        }
        this.nsisListenersRegistered = true;

        autoUpdater.on("error", (err) => {
            if (this.isDownloadingUpdate) {
                this.isCheckingForUpdates = false;
                this.isDownloadingUpdate = false;
            } else {
                this.isCheckingForUpdates = false;
                this.isDownloadingUpdate = false;
                this.updateDownloaded = false;
                this.updateAvailable = false;
                this.releaseVersion = null;
                this.clearReleaseNotes();
                this.updateDialogDismissed = false;
            }
            this.broadcastStatus();

            if (isMissingUpdateMetadataError(err)) {
                // Transition period: latest release has installers but no latest.yml yet.
                this.kd.logger.debug(err, "updater.missingMetadata");
                return;
            }

            this.kd.logger.error(err, "updater");
        });

        autoUpdater.on("update-available", (info) => {
            void this.handleNsisUpdateAvailable(info).catch((error) => {
                this.isCheckingForUpdates = false;
                this.broadcastStatus();
                this.kd.logger.error(
                    {
                        event: "update-available",
                        stage: "process-update-info",
                        message: toErrorMessage(error),
                    },
                    "updater.updateAvailable",
                );
                this.kd.logger.error(error, "updater.updateAvailable");
            });
        });

        autoUpdater.on("update-not-available", () => {
            this.isCheckingForUpdates = false;
            this.isDownloadingUpdate = false;
            this.updateDownloaded = false;
            this.updateAvailable = false;
            this.releaseVersion = null;
            this.clearReleaseNotes();
            this.updateDialogDismissed = false;
            this.broadcastStatus();
        });

        autoUpdater.on("update-downloaded", () => {
            this.isCheckingForUpdates = false;
            this.isDownloadingUpdate = false;
            this.updateDownloaded = true;
            this.updateDialogDismissed = false;
            this.broadcastStatus();
            void this.notifyUpdateReady();
        });

        autoUpdater.on("download-progress", () => {
            if (!this.isDownloadingUpdate) {
                this.isDownloadingUpdate = true;
                this.broadcastStatus();
            }
        });

        autoUpdater.on("update-cancelled", () => {
            this.isDownloadingUpdate = false;
            this.broadcastStatus();
        });
    }

    private async handleNsisUpdateAvailable(info: unknown): Promise<void> {
        const { version, releaseNotes } = updateInfoSchema.parse(info);
        this.isCheckingForUpdates = false;
        this.updateAvailable = true;
        this.releaseVersion = version;
        this.originalReleaseNotesText = this.normalizeReleaseNotes(releaseNotes);
        this.translatedReleaseNotesText = null;
        this.translatedLanguage = null;
        this.broadcastStatus();
        this.broadcastUpdateAvailable();

        try {
            await this.translateCurrentReleaseNotes(await this.getLanguage());
        } catch (err) {
            this.kd.logger.error(err, "updater.translateReleaseNotes");
        }
    }

    public async checkForUpdates(userInitiated = false): Promise<void> {
        const strategy = this.getStrategy();
        if (strategy === "unsupported") {
            if (userInitiated) {
                throw new Error("Updates are not supported for this build.");
            }
            return;
        }

        if (this.isCheckingForUpdates) {
            return;
        }

        if (strategy === "manual") {
            await this.checkForUpdatesManual(userInitiated);
            return;
        }

        const mode = await this.kd.setting.get("general.autoUpdateMode");
        autoUpdater.autoDownload = mode === "auto";

        if (this.updateDownloaded) {
            if (userInitiated) {
                this.updateDialogDismissed = false;
            }
            await this.notifyUpdateReady();
            return;
        }

        if (this.updateAvailable) {
            if (mode === "auto" && !this.isDownloadingUpdate) {
                await this.downloadUpdate();
            } else if (userInitiated) {
                this.updateDialogDismissed = false;
                this.broadcastStatus();
            }
            return;
        }

        this.isCheckingForUpdates = true;
        this.broadcastStatus();

        try {
            await autoUpdater.checkForUpdates();
        } catch (err) {
            this.isCheckingForUpdates = false;
            this.broadcastStatus();
            if (isMissingUpdateMetadataError(err)) {
                if (userInitiated) {
                    throw new Error(
                        "업데이트 메타데이터(latest.yml)가 아직 릴리스에 없습니다. 다음 정식 릴리스부터 자동 업데이트가 동작합니다.",
                    );
                }
                this.kd.logger.debug(err, "updater.check.missingMetadata");
                return;
            }
            throw err;
        }
    }

    private async checkForUpdatesManual(userInitiated: boolean): Promise<void> {
        if (this.updateAvailable) {
            if (userInitiated) {
                this.updateDialogDismissed = false;
                this.broadcastStatus();
                await this.notifyManualUpdateReady();
            }
            return;
        }

        this.isCheckingForUpdates = true;
        this.broadcastStatus();

        try {
            const response = await this.kd.http.request(GITHUB_RELEASES_API_URL, {
                headers: {
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            });
            const responseText = await response.text();
            if (!response.ok) {
                throw new Error(
                    `GitHub releases request failed with status ${response.status}: ${responseText}`,
                );
            }

            const release = githubReleaseSchema.parse(JSON.parse(responseText));
            const latestVersion = release.tag_name.replace(/^v/i, "");
            const currentVersion = app.getVersion();

            if (!isVersionNewer(latestVersion, currentVersion)) {
                this.isCheckingForUpdates = false;
                this.updateAvailable = false;
                this.releaseVersion = null;
                this.clearReleaseNotes();
                this.updateDialogDismissed = false;
                this.broadcastStatus();
                return;
            }

            this.isCheckingForUpdates = false;
            this.updateAvailable = true;
            this.releaseVersion = latestVersion;
            this.originalReleaseNotesText = this.htmlToPlainText(release.body ?? "");
            this.translatedReleaseNotesText = null;
            this.translatedLanguage = null;
            this.updateDialogDismissed = false;
            this.broadcastStatus();
            this.broadcastUpdateAvailable();
            await this.notifyManualUpdateReady();

            try {
                await this.translateCurrentReleaseNotes(await this.getLanguage());
            } catch (err) {
                this.kd.logger.error(err, "updater.translateReleaseNotes");
            }
        } catch (err) {
            this.isCheckingForUpdates = false;
            this.broadcastStatus();
            throw err;
        }
    }

    private async runInitialAutomaticCheck(): Promise<void> {
        if (this.hasRunInitialAutoCheck) {
            return;
        }
        this.hasRunInitialAutoCheck = true;

        try {
            const mode = await this.kd.setting.get("general.autoUpdateMode");
            if (mode === "off") {
                return;
            }
            await this.checkForUpdates();
        } catch (err) {
            if (isMissingUpdateMetadataError(err)) {
                this.kd.logger.debug(err, "updater.initialCheck.missingMetadata");
                return;
            }
            this.kd.logger.error(err, "updater.initialCheck");
        }
    }

    private async runAutomaticCheck(): Promise<void> {
        const mode = await this.kd.setting.get("general.autoUpdateMode");
        if (mode === "off") {
            return;
        }
        await this.checkForUpdates();
    }

    public async handleAutoUpdateModeChanged(mode: AutoUpdateMode): Promise<void> {
        const strategy = this.getStrategy();
        if (strategy === "unsupported") {
            this.broadcastStatus();
            return;
        }

        if (strategy === "nsis") {
            autoUpdater.autoDownload = mode === "auto";
            if (
                mode === "auto" &&
                this.updateAvailable &&
                !this.updateDownloaded &&
                !this.isDownloadingUpdate
            ) {
                await this.downloadUpdate();
                return;
            }
        }

        if (
            mode !== "off" &&
            !this.updateAvailable &&
            !this.updateDownloaded &&
            !this.isCheckingForUpdates
        ) {
            await this.checkForUpdates();
            return;
        }

        this.broadcastStatus();
    }

    public async getStatus(): Promise<UpdaterStatus> {
        const mode = await this.kd.setting.get("general.autoUpdateMode");
        const strategy = this.getStrategy();
        const shouldPromptForUpdate =
            strategy === "manual"
                ? this.updateAvailable && !this.updateDialogDismissed
                : this.updateDownloaded && !this.updateDialogDismissed;

        return {
            mode,
            strategy,
            updateAvailable: this.updateAvailable,
            updateDownloaded: this.updateDownloaded,
            releaseVersion: this.releaseVersion,
            releaseNotes: this.getReleaseNotes(),
            shouldPromptForUpdate,
            isChecking: this.isCheckingForUpdates,
            isDownloading: this.isDownloadingUpdate,
        };
    }

    private getReleaseNotes() {
        if (!this.originalReleaseNotesText && !this.translatedReleaseNotesText) {
            return null;
        }
        return {
            original: this.originalReleaseNotesText,
            translated: this.translatedReleaseNotesText,
            translatedLanguage: this.translatedLanguage,
        };
    }

    private normalizeReleaseNotes(
        releaseNotes:
            | string
            | z.infer<typeof releaseNoteInfoSchema>
            | z.infer<typeof releaseNoteInfoSchema>[]
            | null
            | undefined,
    ): string | null {
        if (!releaseNotes) {
            return null;
        }
        if (typeof releaseNotes === "string") {
            return this.htmlToPlainText(releaseNotes);
        }
        if (Array.isArray(releaseNotes)) {
            const sections = releaseNotes
                .map((item) => this.formatReleaseNoteSection(item))
                .filter((item) => item.length > 0);
            const joined = sections.join("\n\n").trim();
            return joined.length > 0 ? joined : null;
        }
        return this.formatReleaseNoteSection(releaseNotes);
    }

    private formatReleaseNoteSection(noteInfo: z.infer<typeof releaseNoteInfoSchema>): string {
        const versionPrefix = noteInfo.version ? `v${noteInfo.version}\n` : "";
        const noteText = this.htmlToPlainText(noteInfo.note) ?? "";
        return `${versionPrefix}${noteText}`.trim();
    }

    private htmlToPlainText(value: string): string | null {
        const text = htmlToText(value, { wordwrap: false })
            .replace(/\r\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        return text.length > 0 ? text : null;
    }

    private clearReleaseNotes(): void {
        this.originalReleaseNotesText = null;
        this.translatedReleaseNotesText = null;
        this.translatedLanguage = null;
        this.releaseNotesTranslationRequestId += 1;
    }

    private isTranslationLanguage(language: string): language is ReleaseNoteTranslationLanguage {
        return language === "ko" || language === "ja" || language === "zh";
    }

    private async getLanguage(): Promise<string> {
        const language = await this.kd.lib.db.settings.getValue("language");
        return typeof language === "string" && language.length > 0 ? language : "en";
    }

    private async translateCurrentReleaseNotes(language: string): Promise<void> {
        const originalText = this.originalReleaseNotesText;
        const releaseVersion = this.releaseVersion;
        const requestId = ++this.releaseNotesTranslationRequestId;

        if (!originalText || !releaseVersion) {
            return;
        }

        if (!this.isTranslationLanguage(language)) {
            const hadTranslation =
                this.translatedReleaseNotesText !== null || this.translatedLanguage !== null;
            this.translatedReleaseNotesText = null;
            this.translatedLanguage = null;
            if (hadTranslation) {
                this.broadcastStatus();
            }
            return;
        }

        try {
            const translatedText = await this.translateReleaseNotes(originalText, language);
            if (
                requestId !== this.releaseNotesTranslationRequestId ||
                this.originalReleaseNotesText !== originalText ||
                this.releaseVersion !== releaseVersion
            ) {
                return;
            }

            if (!translatedText) {
                const hadTranslation =
                    this.translatedReleaseNotesText !== null || this.translatedLanguage !== null;
                this.translatedReleaseNotesText = null;
                this.translatedLanguage = null;
                if (hadTranslation) {
                    this.broadcastStatus();
                }
                return;
            }

            this.translatedReleaseNotesText = translatedText;
            this.translatedLanguage = language;
            this.broadcastStatus();
        } catch (err) {
            if (requestId !== this.releaseNotesTranslationRequestId) {
                return;
            }
            this.translatedReleaseNotesText = null;
            this.translatedLanguage = null;
            this.kd.logger.error(err, "updater.translateReleaseNotes");
            this.broadcastStatus();
        }
    }

    private async translateReleaseNotes(
        originalText: string,
        language: ReleaseNoteTranslationLanguage,
    ): Promise<string | null> {
        const response = await this.kd.http.request(RELEASE_NOTES_TRANSLATION_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                source: "en",
                target: language,
                text: originalText,
            }),
        });

        const responseText = await response.text();
        if (!response.ok) {
            throw new Error(
                `Release notes translation failed with status ${response.status}: ${responseText}`,
            );
        }

        const translatedText = this.extractTranslatedText(responseText);
        if (!translatedText || translatedText === originalText) {
            return null;
        }
        return translatedText;
    }

    private extractTranslatedText(responseText: string): string {
        const trimmedResponseText = responseText.trim();
        if (!trimmedResponseText) {
            return "";
        }

        try {
            const parsed = translationResponseSchema.parse(JSON.parse(trimmedResponseText));
            if (typeof parsed.response === "string") {
                return parsed.response.trim();
            }
            return parsed.response.choices[0]?.message.content?.trim() ?? "";
        } catch {
            return trimmedResponseText;
        }
    }

    public async showPendingDialogsIfNeeded(): Promise<void> {
        const mainWindow = this.kd.window.main.window;
        if (!mainWindow) {
            return;
        }

        const strategy = this.getStrategy();
        if (strategy === "nsis" && this.updateDownloaded && !this.updateDialogDismissed) {
            this.kd.ipc.postMessageToWindow(mainWindow, "updater:update-downloaded");
            return;
        }

        if (strategy === "manual" && this.updateAvailable && !this.updateDialogDismissed) {
            this.kd.ipc.postMessageToWindow(mainWindow, "updater:update-available");
        }
    }

    public dismissUpdateDialog(): void {
        const strategy = this.getStrategy();
        if (strategy === "nsis" && !this.updateDownloaded) {
            return;
        }
        if (strategy === "manual" && !this.updateAvailable) {
            return;
        }
        this.updateDialogDismissed = true;
        this.broadcastStatus();
    }

    public async downloadUpdate(): Promise<void> {
        if (this.getStrategy() !== "nsis") {
            return;
        }
        if (this.updateDownloaded || !this.updateAvailable || this.isDownloadingUpdate) {
            return;
        }

        this.isDownloadingUpdate = true;
        this.broadcastStatus();

        try {
            await autoUpdater.downloadUpdate();
        } catch (err) {
            this.isDownloadingUpdate = false;
            this.broadcastStatus();
            throw err;
        }
    }

    public async openDownloadPage(): Promise<void> {
        await openExternal(GITHUB_RELEASES_LATEST_URL);
    }

    public async showUpdateUi(): Promise<void> {
        await this.focusMainWindow();
    }

    private async notifyUpdateReady(): Promise<void> {
        const mainWindow = await this.focusMainWindow();
        if (!mainWindow) {
            return;
        }
        this.kd.ipc.postMessageToWindow(mainWindow, "updater:update-downloaded");
    }

    private async notifyManualUpdateReady(): Promise<void> {
        const mainWindow = await this.focusMainWindow();
        if (!mainWindow) {
            return;
        }
        this.kd.ipc.postMessageToWindow(mainWindow, "updater:update-available");
    }

    private broadcastUpdateAvailable(): void {
        this.kd.ipc.broadcast("updater:update-available");
    }

    private broadcastStatus(): void {
        void this.getStatus().then((status) => {
            this.kd.ipc.broadcast("updater:status-changed", status);
        });
    }

    private async focusMainWindow(): Promise<BrowserWindow | null> {
        let mainWindow = this.kd.window.main.window;

        if (!mainWindow || mainWindow.isDestroyed()) {
            mainWindow = await this.kd.window.main.createMainWindow();
        }

        if (!mainWindow || mainWindow.isDestroyed()) {
            return null;
        }

        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }

        mainWindow.show();
        mainWindow.focus();
        return mainWindow;
    }

    public async installUpdate(): Promise<void> {
        if (this.getStrategy() !== "nsis") {
            throw new Error("In-app install is only supported on Windows.");
        }
        if (!this.updateDownloaded || !this.updateAvailable) {
            throw new Error("No update available to install.");
        }

        this.kd.isInstallingUpdate = true;

        app.removeAllListeners("window-all-closed");
        app.removeAllListeners("before-quit");
        app.removeAllListeners("will-quit");

        this.kd.window.main.window?.removeAllListeners("close");
        this.kd.window.main.window?.removeAllListeners("show");
        this.kd.window.main.window?.removeAllListeners("minimize");
        this.kd.window.main.window?.removeAllListeners("maximize");

        try {
            this.kd.service.download.destroy();
            this.kd.service.upload.destroy();
        } catch (err) {
            this.kd.logger.error(err, "updater.installUpdate.destroyServices");
        }

        try {
            for (const window of BrowserWindow.getAllWindows()) {
                window.destroy();
            }
        } catch (err) {
            this.kd.logger.error(err, "updater.installUpdate.destroyWindows");
        }

        autoUpdater.quitAndInstall(false, true);
        setTimeout(() => {
            app.exit(0);
        }, 1000);
    }
}

function isVersionNewer(latestVersion: string, currentVersion: string): boolean {
    const latestParts = parseVersionParts(latestVersion);
    const currentParts = parseVersionParts(currentVersion);
    const length = Math.max(latestParts.length, currentParts.length);

    for (let index = 0; index < length; index += 1) {
        const latest = latestParts[index] ?? 0;
        const current = currentParts[index] ?? 0;
        if (latest > current) {
            return true;
        }
        if (latest < current) {
            return false;
        }
    }

    return false;
}

function parseVersionParts(version: string): number[] {
    return version
        .replace(/^v/i, "")
        .split(/[.+-]/)
        .map((part) => Number.parseInt(part, 10))
        .map((part) => (Number.isFinite(part) ? part : 0));
}

function isMissingUpdateMetadataError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes("Cannot find latest.yml") ||
        message.includes("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") ||
        (message.includes("latest.yml") && message.includes("404"))
    );
}

export default Updater;
