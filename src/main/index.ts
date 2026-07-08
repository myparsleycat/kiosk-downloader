import path from "node:path";

import { electronApp, optimizer } from "@electron-toolkit/utils";
import AutoLaunch from "auto-launch";
import { app } from "electron";

import { IS_ELECTRON } from "./const";
import { IPC } from "./ipc";
import { DB_FILE_NAME } from "./lib/const";
import { DatabaseClient } from "./lib/db/client";
import { FS } from "./lib/fs";
import { HTTP } from "./lib/http";
import { isPortable } from "./lib/isPortable";
import { Tray } from "./lib/tray";
import { Utils } from "./lib/utils";
import { Logger } from "./logger";
import { DownloadService } from "./service/download";
import { StartupCleanupService } from "./service/startup-cleanup";
import { TransferService } from "./service/transfer";
import { Setting } from "./setting";
import { MainWindow } from "./window/main";

if (IS_ELECTRON) {
    // Needs to be here, otherwise Chromium's FileSystemAccess API won't work. Waiting for the electron team to fix it.
    // Ref: https://github.com/electron/electron/issues/28422
    app?.commandLine.appendSwitch("enable-experimental-web-platform-features");
    app?.commandLine.appendSwitch("disable-renderer-backgrounding");
    app?.commandLine.appendSwitch("disable-pinch-zoom");
    app?.commandLine.appendSwitch("disable-pinch");
}

const dbPath = !app.isPackaged ? DB_FILE_NAME : path.join(app.getPath("userData"), "data.db");

export class KioskDownloader {
    public readonly ipc: IPC;
    public readonly setting: Setting;
    public readonly http: HTTP;
    public readonly logger: Logger;

    public initialized: boolean = false;
    public minimizeToTray: boolean = false;

    public window: {
        main: MainWindow;
    };
    public lib: {
        db: DatabaseClient;
        fs: FS;
        utils: Utils;
        tray: Tray;
    };

    public service: {
        transfer: TransferService;
        download: DownloadService;
        startupCleanup: StartupCleanupService;
    };

    public constructor() {
        this.setting = new Setting(this);
        this.ipc = new IPC(this);
        this.logger = new Logger(false, false);
        this.http = new HTTP(this);
        this.window = {
            main: new MainWindow(this),
        };
        this.lib = {
            db: new DatabaseClient(dbPath),
            fs: new FS(this),
            utils: new Utils(this),
            tray: new Tray(this),
        };

        this.service = {
            transfer: new TransferService(this),
            startupCleanup: new StartupCleanupService(this),
            download: new DownloadService(this),
        };
    }

    private async syncAutoLaunchSetting() {
        if (!app.isPackaged || isPortable()) {
            return;
        }

        try {
            const runOnStartup = await this.setting.general.getRunOnStartup();
            const autoLaunch = new AutoLaunch({
                name: "Kiosk Downloader",
                path: app.getPath("exe"),
                isHidden: true,
            });

            if (runOnStartup) {
                await autoLaunch.enable();
                return;
            }

            await autoLaunch.disable();
        } catch (error) {
            this.logger.error(`Failed to sync auto launch setting: ${String(error)}`, "App");
        }
    }

    public async init() {
        if (this.initialized) return;

        // Reconcile before services because some constructors may read persisted app state.
        await this.lib.db.reconcile();

        this.service.download.registerStartupTasks();
        await this.service.startupCleanup.runAll();

        // init lang
        const lang = await this.lib.db.settings.getValue("language");
        if (!lang) {
            const locale = app.getLocale();
            if (locale.startsWith("en")) await this.lib.db.settings.upsert("language", "en");
            else if (locale === "ko") await this.lib.db.settings.upsert("language", "ko");
            else if (locale.startsWith("zh")) await this.lib.db.settings.upsert("language", "zh");
            else await this.lib.db.settings.upsert("language", "en");
        }

        // make tray
        this.lib.tray.createTray();

        this.initialized = true;

        const logLevel = await this.setting.general.getLogLevel();
        this.logger.setLevel(logLevel);

        await this.window.main.createMainWindow();
        await this.service.download.restoreStartupState();
        void this.syncAutoLaunchSetting();
    }
}

export const kd = new KioskDownloader();

void app.whenReady().then(() => {
    const gotTheLock = app.requestSingleInstanceLock();

    if (!gotTheLock) {
        app.quit();
        return;
    }

    app.on("second-instance", async (_event, _commandLine, _workingDirectory) => {
        try {
            let mainWindow = kd.window.main.window;
            if (!mainWindow || mainWindow.isDestroyed()) {
                mainWindow = await kd.window.main.createMainWindow();
            }

            if (!mainWindow || mainWindow.isDestroyed()) {
                return;
            }

            kd.window.main.focus();
        } catch (error) {
            kd.logger.error(`Failed to handle second-instance event: ${String(error)}`, "App");
            return;
        }
    });

    electronApp.setAppUserModelId("com.kiodl.app");

    // if (process.platform === "darwin") {
    //     app.dock?.setIcon(nativeImage.createFromPath(icon));
    // }

    app.on("browser-window-created", (_, window) => {
        optimizer.watchWindowShortcuts(window);
    });

    void kd.init();
});

app.on("window-all-closed", async () => {
    const runInBackground = await kd.setting.general.getRunInBackground();
    if (!runInBackground) {
        app.quit();
    }
});

app.on("before-quit", () => {
    try {
        kd.service.download.destroy();
    } catch (error) {
        kd.logger.error(error, "App:before-quit");
    }
});
