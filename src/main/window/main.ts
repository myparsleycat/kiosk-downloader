import { fileURLToPath } from "node:url";

import { is } from "@electron-toolkit/utils";
import { openExternal } from "@main/service/util";
import { BrowserWindow, nativeTheme, screen } from "electron";
import { debounce } from "es-toolkit";

import { KioskDownloader } from "..";
import icon from "../../../resources/Icon-macOS-512.png?asset";
import { TRAFFIC_LIGHT_Y, createTitleBarOverlay } from "./titleBar";
import { focus, getDefaultWebPreferences } from "./utils";

export class MainWindow {
    private readonly kd: KioskDownloader;
    public window: BrowserWindow | null;

    constructor(kd: KioskDownloader) {
        this.kd = kd;
        this.window = null;
    }

    public focus() {
        if (!this.window || this.window.isDestroyed()) {
            this.window = null;
            void this.createMainWindow();
        } else {
            focus(this.window);
        }
    }

    async createMainWindow(initialRoute?: string) {
        if (this.window?.isDestroyed()) {
            this.window = null;
        }

        if (this.window) {
            focus(this.window);
            return this.window;
        }

        const theme = await this.kd.setting.get("general.theme");
        nativeTheme.themeSource = theme;

        const savedBounds = await this.kd.setting.getBounds();
        let bounds = savedBounds;

        if (bounds) {
            const displays = screen.getAllDisplays();
            const isValid = displays.some((display) => {
                const area = display.workArea;
                return (
                    bounds!.x >= area.x &&
                    bounds!.y >= area.y &&
                    bounds!.x < area.x + area.width &&
                    bounds!.y < area.y + area.height
                );
            });

            if (!isValid) {
                bounds = null;
            }
        }

        const useDarkColors =
            theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);

        this.window = new BrowserWindow({
            title: "Kiosk Desktop",
            x: bounds?.x || undefined,
            y: bounds?.y || undefined,
            width: bounds?.width || 1200,
            height: bounds?.height || 800,
            minWidth: 800,
            minHeight: 600,
            titleBarStyle: "hidden",
            ...(process.platform === "darwin"
                ? {
                      trafficLightPosition: {
                          x: 12,
                          y: TRAFFIC_LIGHT_Y,
                      },
                  }
                : { titleBarOverlay: createTitleBarOverlay() }),
            show: false,
            backgroundColor: useDarkColors ? "#1c1c1c" : "#ffffff",
            autoHideMenuBar: true,
            webPreferences: {
                ...getDefaultWebPreferences(),
            },
            icon,
        });

        let hasShownWindow = false;
        const showWindow = async () => {
            if (!this.window || this.window.isDestroyed() || hasShownWindow) {
                return;
            }

            hasShownWindow = true;
            this.window.show();
        };

        this.window.once("ready-to-show", () => {
            void showWindow();
        });

        this.window.webContents.once("did-finish-load", () => {
            void showWindow();
        });

        const saveBounds = debounce(async () => {
            if (!this.window) return;
            if (
                this.window.isMaximized() ||
                this.window.isMinimized() ||
                this.window.isFullScreen()
            )
                return;
            const bounds = this.window.getBounds();
            await this.kd.setting.setBounds(bounds);
        }, 1000);

        this.window.on("resize", saveBounds);
        this.window.on("move", saveBounds);

        this.window.on("close", async () => {
            saveBounds.cancel();
            if (!this.window) return;
            if (this.window.isDestroyed()) return;
            if (
                this.window.isMaximized() ||
                this.window.isMinimized() ||
                this.window.isFullScreen()
            )
                return;
            const bounds = this.window.getBounds();
            await this.kd.setting.setBounds(bounds);
        });

        this.window.on("closed", () => {
            saveBounds.cancel();
            this.window = null;
        });

        this.window.webContents.setWindowOpenHandler((details) => {
            void openExternal(details.url);
            return { action: "deny" };
        });

        if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
            const baseUrl = process.env["ELECTRON_RENDERER_URL"];
            const routeUrl = initialRoute ? `${baseUrl}/#${initialRoute}` : baseUrl;
            void this.window.loadURL(routeUrl);
        } else {
            void this.window.loadFile(
                fileURLToPath(new URL("../renderer/index.html", import.meta.url)),
                {
                    hash: initialRoute ? initialRoute.slice(1) : undefined,
                },
            );
        }

        this.window.on("blur", () => {
            if (!this.window) return;
            this.kd.ipc.postMessageToWindow(this.window, "window:blur");
        });

        this.window.on("focus", () => {
            if (!this.window) return;
            this.kd.ipc.postMessageToWindow(this.window, "window:focus");
        });

        return this.window;
    }
}

export default MainWindow;
