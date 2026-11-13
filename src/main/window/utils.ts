import path from "node:path";
import { fileURLToPath } from "node:url";

import { is } from "@electron-toolkit/utils";
import isDev from "@main/lib/isDev";
import type { BrowserWindow, WebFrameMain } from "electron";

export function getDefaultWebPreferences() {
    return {
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required" as const,
        contextIsolation: true,
        nodeIntegration: false,
        experimentalFeatures: false,
        devTools: isDev,
        zoomFactor: 1,
        sandbox: true as const,
        // cjs
        preload: path.join(__dirname, "../preload/index.js"),

        // esm
        // preload: fileURLToPath(new URL("../preload/index.mjs", import.meta.url)),
    } as Electron.WebPreferences;
}

export function focus(window: BrowserWindow) {
    if (window.isDestroyed()) return;

    if (window.isMinimized()) window.restore();

    window.setAlwaysOnTop(true);
    window.show();
    window.focus();
    window.setAlwaysOnTop(false);

    window.moveTop();
}

export const RENDERER_INDEX_PATH = path.join(__dirname, "../renderer/index.html");

/** The Vite dev server URL when the main window loads from it instead of the built files. */
export function getDevRendererUrl() {
    return is.dev ? (process.env["ELECTRON_RENDERER_URL"] ?? null) : null;
}

/** Whether a URL is exactly the renderer entry the main window loads. */
export function isAppRendererUrl(rawUrl: string) {
    const url = URL.parse(rawUrl);
    if (!url) return false;
    const devRendererUrl = getDevRendererUrl();
    if (devRendererUrl) return url.origin === URL.parse(devRendererUrl)?.origin;
    if (url.protocol !== "file:") return false;
    try {
        return isSamePath(fileURLToPath(url), RENDERER_INDEX_PATH);
    } catch {
        // fileURLToPath rejects file URLs that cannot map to a local path (e.g. remote hosts).
        return false;
    }
}

// The preload bridge is attached to every page the window loads, so IPC must also verify that
// the caller is the app's own top-level renderer and not some other document.
export function isTrustedIpcSender(frame: WebFrameMain | null) {
    return Boolean(frame && !frame.parent && isAppRendererUrl(frame.url));
}

function isSamePath(left: string, right: string) {
    const normalize = (value: string) => {
        const resolved = path.resolve(value);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
}
