import type { AppConnection, AppFailure, AppResult, SendResult } from "@ext/shared/messages";
import {
    BROWSER_EXTENSION_API_PREFIX,
    BROWSER_EXTENSION_APP_NAME,
    BROWSER_EXTENSION_PAIRING_PROTOCOL,
    BROWSER_EXTENSION_POPOVER_PROTOCOL,
    BROWSER_EXTENSION_PORTS,
    type BrowserExtensionErrorResponse,
    type BrowserExtensionPingResponse,
    type BrowserExtensionPrepareRequest,
    type BrowserExtensionPrepareResponse,
    type BrowserExtensionRequestItem,
    type BrowserExtensionStartRequest,
    type BrowserExtensionStartResponse,
    type BrowserExtensionZipEntriesRequest,
    DEEP_LINK_OPEN_URL,
} from "@shared/browser-extension";
import type { ListZipEntriesResult } from "@shared/types";
import { delay } from "es-toolkit";

const PING_TIMEOUT_MS = 800;
// Covers the pairing dialog the app shows on the first request from this extension.
const REQUEST_TIMEOUT_MS = 120_000;
const PAIRING_POLL_MS = 1000;
const LAUNCH_WAIT_MS = 15_000;
const LAUNCH_POLL_MS = 500;

let cachedPort: number | null = null;

export async function getConnection(): Promise<AppConnection> {
    const ports = cachedPort
        ? [cachedPort, ...BROWSER_EXTENSION_PORTS.filter((port) => port !== cachedPort)]
        : BROWSER_EXTENSION_PORTS;
    for (const port of ports) {
        const ping = await pingPort(port);
        if (!ping) continue;
        cachedPort = port;
        return {
            state: ping.paired ? "connected" : "pairingRequired",
            port,
            version: ping.version,
            protocol: ping.protocol,
        };
    }
    cachedPort = null;
    return { state: "offline" };
}

export async function requestPairing(): Promise<AppConnection> {
    const connection = await getConnection();
    if (
        connection.state !== "pairingRequired" ||
        connection.protocol < BROWSER_EXTENSION_PAIRING_PROTOCOL
    )
        return connection;
    await pairWithApp(connection.port, true);
    return getConnection();
}

export async function sendItems(items: BrowserExtensionRequestItem[]): Promise<SendResult> {
    const result = await requestApp("/requests", { items });
    return result.ok ? { ok: true } : result;
}

/** Sends items, launching the app through its deep link first when it is not running. */
export function sendItemsLaunchingApp(
    items: BrowserExtensionRequestItem[],
    tabId: number | undefined,
): Promise<SendResult> {
    return runLaunchingApp(() => sendItems(items), tabId);
}

export async function prepareShare(
    request: BrowserExtensionPrepareRequest,
): Promise<AppResult<BrowserExtensionPrepareResponse>> {
    const result = await requestApp("/prepare", request, BROWSER_EXTENSION_POPOVER_PROTOCOL);
    if (!result.ok) return result;
    return { ok: true, value: (await result.response.json()) as BrowserExtensionPrepareResponse };
}

export async function startDownload(
    request: BrowserExtensionStartRequest,
): Promise<AppResult<BrowserExtensionStartResponse>> {
    const result = await requestApp("/start", request, BROWSER_EXTENSION_POPOVER_PROTOCOL);
    if (!result.ok) return result;
    return { ok: true, value: (await result.response.json()) as BrowserExtensionStartResponse };
}

export async function listZipEntries(
    request: BrowserExtensionZipEntriesRequest,
): Promise<AppResult<ListZipEntriesResult>> {
    const result = await requestApp("/zip-entries", request, BROWSER_EXTENSION_POPOVER_PROTOCOL);
    if (!result.ok) return result;
    return { ok: true, value: (await result.response.json()) as ListZipEntriesResult };
}

/** Best effort: survives the popover page unloading, and the app also caps leftover drafts. */
export async function discardShareDraft(draftId: string) {
    if (!cachedPort) return;
    await postJson(cachedPort, "/discard", { draftId }, { keepalive: true });
}

/** Runs an app request, launching the app through its deep link first when it is not running. */
export async function runLaunchingApp<R extends { ok: true } | AppFailure>(
    run: () => Promise<R>,
    tabId: number | undefined,
): Promise<R> {
    const result = await run();
    if (!("reason" in result) || result.reason !== "offline") return result;
    const connection = await launchApp(tabId);
    if (connection.state === "offline") return result;
    return run();
}

async function requestApp(
    path: string,
    body: unknown,
    minProtocol = BROWSER_EXTENSION_PAIRING_PROTOCOL,
): Promise<{ ok: true; response: Response } | AppFailure> {
    const connection = await getConnection();
    if (connection.state === "offline") {
        return { ok: false, reason: "offline" };
    }
    if (connection.protocol < Math.max(minProtocol, BROWSER_EXTENSION_PAIRING_PROTOCOL)) {
        return { ok: false, reason: "outdated" };
    }
    if (connection.state === "pairingRequired") {
        const paired = await pairWithApp(connection.port);
        if (!paired.ok) return paired;
    }
    return readAppResponse(await postJson(connection.port, path, body));
}

async function pairWithApp(port: number, retryDenied = false): Promise<SendResult> {
    const result = await readAppResponse(await postJson(port, "/pair", { retryDenied }));
    if (!result.ok) return result;
    if (result.response.status !== 202) return { ok: true };

    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await delay(PAIRING_POLL_MS);
        // Extension API activity keeps this finite approval wait alive in the service worker.
        await chrome.runtime.getPlatformInfo();
        const ping = await pingPort(port);
        if (!ping) return { ok: false, reason: "offline" };
        if (ping.paired) return { ok: true };
        if (ping.pairingDenied) return { ok: false, reason: "pairingDenied" };
    }
    return { ok: false, reason: "failed", message: "앱의 연결 승인 대기 시간이 초과되었습니다." };
}

async function readAppResponse(
    response: Response | null,
): Promise<{ ok: true; response: Response } | AppFailure> {
    if (!response) {
        return { ok: false, reason: "failed", message: "앱에 연결하지 못했습니다." };
    }
    if (response.ok) {
        return { ok: true, response };
    }
    const error = (await response.json().catch(() => null)) as BrowserExtensionErrorResponse | null;
    if (error?.error === "pairingDenied") {
        return { ok: false, reason: "pairingDenied" };
    }
    return {
        ok: false,
        reason: "failed",
        message: error?.message ?? error?.error ?? `HTTP ${response.status}`,
    };
}

export async function launchApp(tabId: number | undefined): Promise<AppConnection> {
    const targetTabId = tabId ?? (await findActiveTabId());
    if (targetTabId === undefined) {
        return { state: "offline" };
    }
    // Navigating a tab to the custom scheme hands it to the OS (after the browser's own
    // confirmation prompt) and leaves the page loaded in that tab untouched.
    await chrome.tabs.update(targetTabId, { url: DEEP_LINK_OPEN_URL });

    const deadline = Date.now() + LAUNCH_WAIT_MS;
    while (Date.now() < deadline) {
        await delay(LAUNCH_POLL_MS);
        const connection = await getConnection();
        if (connection.state !== "offline") return connection;
    }
    return { state: "offline" };
}

async function findActiveTabId() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id;
}

async function pingPort(port: number) {
    try {
        const response = await fetch(apiUrl(port, "/ping"), {
            // Chromium omits Origin on GET requests covered by extension host permissions.
            method: "POST",
            signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as Partial<BrowserExtensionPingResponse>;
        return body.app === BROWSER_EXTENSION_APP_NAME
            ? (body as BrowserExtensionPingResponse)
            : null;
    } catch {
        // Nothing listening, a timeout, or another program on the port: try the next one.
        return null;
    }
}

async function postJson(
    port: number,
    path: string,
    body: unknown,
    options: { keepalive?: boolean } = {},
) {
    try {
        return await fetch(apiUrl(port, path), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            keepalive: options.keepalive,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (error) {
        console.warn("[kioex] request to Kiosk Downloader failed", { port, path, error });
        return null;
    }
}

function apiUrl(port: number, path: string) {
    return `http://127.0.0.1:${port}${BROWSER_EXTENSION_API_PREFIX}${path}`;
}
