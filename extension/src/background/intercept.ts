import { type ExtensionSettings, loadSettings, matchesHost } from "@ext/shared/settings";

import { getConnection, launchApp, sendItems } from "./app-client";
import { buildDirectRequestHeaders } from "./request-headers";
import { createRequestMethodGuard } from "./request-methods";

const MIB = 1024 * 1024;
// A failed launch (app not installed, protocol prompt dismissed) would otherwise hold every later
// download for the full launch wait and show the protocol prompt again each time.
const LAUNCH_RETRY_COOLDOWN_MS = 5 * 60_000;

let lastFailedLaunchAt = 0;

export function registerDownloadInterception() {
    const methods = createRequestMethodGuard();
    const filter = { urls: ["http://*/*", "https://*/*"] };
    chrome.webRequest.onBeforeRequest.addListener(methods.observe, filter);
    chrome.webRequest.onHeadersReceived.addListener(methods.observe, filter);
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
        if (!methods.isGetDownload(item)) {
            suggest();
            return true;
        }
        void interceptDownload(item, () => methods.isGetDownload(item))
            .catch((error) => {
                console.error("[kioex] download interception failed", { url: item.url, error });
                return false;
            })
            .then((intercepted) => {
                if (!intercepted) suggest();
            });
        // Keeps the download waiting for suggest() while the app is contacted.
        return true;
    });
}

async function interceptDownload(item: chrome.downloads.DownloadItem, canReplay: () => boolean) {
    const settings = await loadSettings();
    const url = item.finalUrl || item.url;
    if (!shouldIntercept(item, url, settings) || !canReplay()) {
        return false;
    }

    const connection = await getConnection();
    const launch =
        connection.state === "offline" &&
        settings.intercept.launchApp &&
        Date.now() - lastFailedLaunchAt >= LAUNCH_RETRY_COOLDOWN_MS;
    if (connection.state !== "connected" && !launch) {
        return false;
    }

    try {
        if (!(await handOff(url, item.referrer, connection.state === "connected", canReplay))) {
            return false;
        }
    } catch (error) {
        console.error("[kioex] sending download to Kiosk Downloader failed", { url, error });
        return false;
    }

    // The app has already queued this request; later URL observations cannot undo the handoff.
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
    return true;
}

async function handOff(
    url: string,
    referrer: string,
    connected: boolean,
    canReplay: () => boolean,
) {
    if (!connected && (await launchApp(undefined)).state !== "connected") {
        lastFailedLaunchAt = Date.now();
        return false;
    }
    const headers = await buildDirectRequestHeaders(url, referrer);
    if (!canReplay()) return false;
    const result = await sendItems([{ url, headers, source: "intercept" }]);
    if (!result.ok) {
        console.warn("[kioex] Kiosk Downloader did not accept the download", { url, result });
    }
    return result.ok;
}

function shouldIntercept(
    item: chrome.downloads.DownloadItem,
    url: string,
    settings: ExtensionSettings,
) {
    const intercept = settings.intercept;
    if (!intercept.enabled || item.byExtensionId || item.incognito) return false;
    if (item.mime === "text/html" || item.mime === "application/xhtml+xml") return false;

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    // blob:, data: and file: downloads only exist inside the browser.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

    // item.url is the pre-redirect URL, so an excluded host that redirects to a CDN stays excluded.
    const excluded = [parsed.hostname, safeHostname(item.url), safeHostname(item.referrer)].some(
        (host) => host && matchesHost(host, intercept.excludedHosts),
    );
    if (excluded) return false;

    if (intercept.extensions.length > 0) {
        const name = item.filename.split(/[\\/]/).pop() ?? "";
        const dot = name.lastIndexOf(".");
        if (dot <= 0 || !intercept.extensions.includes(name.slice(dot + 1).toLowerCase())) {
            return false;
        }
    }

    // Unknown sizes (0 or -1) are intercepted; only a known small size is skipped.
    const size = item.totalBytes > 0 ? item.totalBytes : item.fileSize;
    return !(intercept.minSizeMiB > 0 && size > 0 && size < intercept.minSizeMiB * MIB);
}

function safeHostname(url: string) {
    return URL.parse(url)?.hostname ?? null;
}
