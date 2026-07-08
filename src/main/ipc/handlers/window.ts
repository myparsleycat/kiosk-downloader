import type { TitleBarOverlaySyncOptions } from "@shared/types";

import type { KioskDownloader } from "../..";

import { applyTitleBarOverlay } from "../../window/titleBar";
import { rh } from "../helper";

export function registerWindowHandlers(kd: KioskDownloader) {
    rh("window:syncTitleBarOverlay", (options: TitleBarOverlaySyncOptions) => {
        const window = kd.window.main.window;
        if (!window || window.isDestroyed()) return;
        applyTitleBarOverlay(window, options);
    });
}
