import type { TitleBarOverlaySyncOptions } from "@shared/types";
import type { BrowserWindow, TitleBarOverlayOptions } from "electron";

export const TITLE_BAR_HEIGHT = 42;

const TRAFFIC_LIGHT_SIZE = 20;

export const TRAFFIC_LIGHT_Y = Math.round((TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2) + 3;

const TRANSPARENT_OVERLAY_COLOR = "#00000000";

const DEFAULT_SYMBOL_COLOR = "#252525";

export function createTitleBarOverlay(
    options: TitleBarOverlaySyncOptions = { symbolColor: DEFAULT_SYMBOL_COLOR },
): TitleBarOverlayOptions {
    return {
        height: TITLE_BAR_HEIGHT,
        color: TRANSPARENT_OVERLAY_COLOR,
        symbolColor: options.symbolColor,
    };
}

export function applyTitleBarOverlay(
    window: BrowserWindow,
    options: TitleBarOverlaySyncOptions = { symbolColor: DEFAULT_SYMBOL_COLOR },
) {
    if (process.platform === "darwin") return;
    if (window.isDestroyed()) return;

    window.setTitleBarOverlay(createTitleBarOverlay(options));
}
