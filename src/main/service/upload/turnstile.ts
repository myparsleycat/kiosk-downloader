import {
    BrowserWindow,
    session,
    type BrowserWindowConstructorOptions,
    type Session,
} from "electron";

import type { KioskDownloader } from "../..";

// Turnstile validates the origin against the site key's configured hostname,
// so the widget must render on the kio.ac origin. These constants are injected
// server-side (PUBLIC_TURNSTILE_SITE_KEY); confirmed value from the /upload page.
const TURNSTILE_SITEKEY = "0x4AAAAAABCKdPyYZ6jgsDdR";
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const UPLOAD_URL = "https://kio.ac/upload";
const TOKEN_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1000;
const TOKEN_CONSOLE_PREFIX = "__KIO_TURNSTILE_TOKEN__:";
const ERROR_CONSOLE_PREFIX = "__KIO_TURNSTILE_ERROR__:";

// Main-world stealth patches adapted from common puppeteer-extra-plugin-stealth
// evasions. Must run in the page main world (not an isolated preload world)
// before Turnstile's script evaluates fingerprints.
const STEALTH_SCRIPT = `
(() => {
    if (window.__kioStealthApplied) return;
    window.__kioStealthApplied = true;

    try {
        // navigator.webdriver — Electron is usually false already; force undefined
        // like stock Chrome (property missing / undefined, not false).
        if ('webdriver' in Navigator.prototype) {
            delete Navigator.prototype.webdriver;
        }
        Object.defineProperty(Navigator.prototype, 'webdriver', {
            get: () => undefined,
            configurable: true,
        });
    } catch {}

    try {
        // window.chrome — stock Chrome always exposes this; Electron may not fully.
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) {
            window.chrome.runtime = {
                connect: () => {},
                sendMessage: () => {},
                id: undefined,
            };
        }
        if (typeof window.chrome.csi !== 'function') {
            window.chrome.csi = () => ({});
        }
        if (typeof window.chrome.loadTimes !== 'function') {
            window.chrome.loadTimes = () => ({});
        }
        if (!window.chrome.app) {
            window.chrome.app = {
                isInstalled: false,
                InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
            };
        }
    } catch {}

    try {
        // Fake a single PDF plugin entry — empty plugins is a classic automation signal.
        const pluginData = [
            { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        ];
        const makePlugin = (p) => {
            const plugin = Object.create(Plugin.prototype);
            Object.defineProperties(plugin, {
                name: { get: () => p.name },
                filename: { get: () => p.filename },
                description: { get: () => p.description },
                length: { get: () => 1 },
            });
            return plugin;
        };
        const plugins = pluginData.map(makePlugin);
        Object.defineProperty(Navigator.prototype, 'plugins', {
            get() {
                const arr = Object.create(PluginArray.prototype);
                plugins.forEach((p, i) => { arr[i] = p; });
                Object.defineProperty(arr, 'length', { get: () => plugins.length });
                arr.item = (i) => plugins[i] ?? null;
                arr.namedItem = (n) => plugins.find((p) => p.name === n) ?? null;
                arr.refresh = () => {};
                return arr;
            },
            configurable: true,
        });
    } catch {}

    try {
        const originalQuery = window.Permissions?.prototype?.query;
        if (originalQuery) {
            window.Permissions.prototype.query = function (parameters) {
                if (parameters && parameters.name === 'notifications') {
                    return Promise.resolve({ state: Notification.permission, onchange: null });
                }
                return originalQuery.call(this, parameters);
            };
        }
    } catch {}

    try {
        // Hide Electron-ish brand strings from high-entropy UA Client Hints if present.
        const uad = navigator.userAgentData;
        if (uad && typeof uad.getHighEntropyValues === 'function') {
            const original = uad.getHighEntropyValues.bind(uad);
            Object.defineProperty(Navigator.prototype, 'userAgentData', {
                get() {
                    const proxy = Object.create(uad);
                    proxy.getHighEntropyValues = async (hints) => {
                        const values = await original(hints);
                        if (Array.isArray(values.brands)) {
                            values.brands = values.brands
                                .filter((b) => !/electron/i.test(b.brand))
                                .map((b) =>
                                    /chromium/i.test(b.brand)
                                        ? { brand: 'Google Chrome', version: b.version }
                                        : b,
                                );
                        }
                        if (Array.isArray(values.fullVersionList)) {
                            values.fullVersionList = values.fullVersionList
                                .filter((b) => !/electron/i.test(b.brand))
                                .map((b) =>
                                    /chromium/i.test(b.brand)
                                        ? { brand: 'Google Chrome', version: b.version }
                                        : b,
                                );
                        }
                        return values;
                    };
                    return proxy;
                },
                configurable: true,
            });
        }
    } catch {}

    try {
        // outerWidth/outerHeight = 0 is an automation smell for some checkers.
        if (window.outerWidth === 0 || window.outerHeight === 0) {
            Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
            Object.defineProperty(window, 'outerHeight', {
                get: () => window.innerHeight + 85,
            });
        }
    } catch {}
})();
`;

// The injected page: blanks the kio.ac/upload DOM and renders a standalone
// Turnstile widget. The origin stays https://kio.ac so the site key validates.
// "managed" mode auto-solves when possible and falls back to interactive.
const RENDER_WIDGET_SCRIPT = `
${STEALTH_SCRIPT}

document.documentElement.innerHTML =
    '<head><meta charset="utf-8"><title>kiosk — Turnstile</title>' +
    '<style>' +
    'body{display:flex;flex-direction:column;gap:16px;justify-content:center;' +
    'align-items:center;height:100vh;margin:0;font-family:system-ui,sans-serif;color:#333;background:#fafafa}' +
    'h2{font-weight:600;margin:0}p{color:#888;font-size:13px;margin:0}' +
    '</style></head>' +
    '<body>' +
    '<h2>보안 인증 대기 중</h2>' +
    '<div id="widget"></div>' +
    '<p>잠시만 기다려 주세요. 완료되면 자동으로 진행됩니다.</p>' +
    '</body>';

window.__turnstileToken = null;
window.__turnstileError = null;
window.__turnstileWidgetId = null;
window.__turnstileRetries = 0;

const reportToken = (t) => {
    window.__turnstileToken = t;
    console.log(${JSON.stringify(TOKEN_CONSOLE_PREFIX)} + t);
};
const reportError = (e) => {
    const msg = String(e);
    window.__turnstileError = msg;
    console.log(${JSON.stringify(ERROR_CONSOLE_PREFIX)} + msg);
};

const s = document.createElement('script');
s.src = ${JSON.stringify(TURNSTILE_SRC)};
s.onload = () => {
    try {
        // Re-apply stealth after DOM wipe (new document identity).
        window.__kioStealthApplied = false;
        ${STEALTH_SCRIPT}
        window.__turnstileWidgetId = window.turnstile.render('#widget', {
            sitekey: ${JSON.stringify(TURNSTILE_SITEKEY)},
            retry: 'auto',
            'retry-interval': 3000,
            callback: reportToken,
            'error-callback': (e) => {
                reportError(e);
                // 600* is retryable; give managed mode a few automatic resets.
                if (window.__turnstileRetries < 3 && window.__turnstileWidgetId != null) {
                    window.__turnstileRetries += 1;
                    setTimeout(() => {
                        try { window.turnstile.reset(window.__turnstileWidgetId); }
                        catch (err) { reportError(err); }
                    }, 1500 + window.__turnstileRetries * 500);
                }
            },
        });
    } catch (e) { reportError(e); }
};
s.onerror = () => { reportError('failed to load turnstile script'); };
document.head.appendChild(s);
`;

const READ_TOKEN_SCRIPT = `
(() => ({ token: window.__turnstileToken, error: window.__turnstileError }))()
`;

const STEALTH_ONLY_SCRIPT = STEALTH_SCRIPT;

export class TurnstileSolver {
    private activeWindow: BrowserWindow | null = null;
    private activeSession: Session | null = null;

    public constructor(private readonly kd: KioskDownloader) {}

    // Open a modal child window on the kio.ac origin, render a Turnstile widget,
    // and wait for the solved token. Applies best-effort stealth so Electron looks
    // closer to stock Chrome; network-level TLS fingerprint still differs.
    public async solve(parentWindow?: BrowserWindow | null): Promise<string> {
        const ua = this.buildChromeUserAgent();
        const partition = `turnstile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ses = session.fromPartition(partition, { cache: false });
        this.configureSession(ses, ua);

        const window = new BrowserWindow(this.buildWindowOptions(parentWindow, ses));
        this.activeWindow = window;
        this.activeSession = ses;

        window.on("closed", () => {
            this.activeWindow = null;
            this.activeSession = null;
        });

        try {
            // Patch as early as the first document allows, before SPA scripts settle.
            window.webContents.on("dom-ready", () => {
                if (window.isDestroyed()) return;
                void window.webContents
                    .executeJavaScript(STEALTH_ONLY_SCRIPT, true)
                    .catch(() => {});
            });

            await window.loadURL(UPLOAD_URL, { userAgent: ua });
            await window.webContents.executeJavaScript(RENDER_WIDGET_SCRIPT, true);

            return await this.waitForToken(window);
        } finally {
            this.destroyWindow();
        }
    }

    public destroy() {
        this.destroyWindow();
    }

    private buildWindowOptions(
        parentWindow: BrowserWindow | null | undefined,
        ses: Session,
    ): BrowserWindowConstructorOptions {
        return {
            parent: parentWindow ?? undefined,
            modal: parentWindow != null,
            title: "보안 인증",
            // Slightly larger than the bare widget so outer/inner metrics look normal.
            width: 520,
            height: 480,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            autoHideMenuBar: true,
            backgroundColor: "#fafafa",
            show: true,
            webPreferences: {
                session: ses,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                webSecurity: true,
                backgroundThrottling: false,
                // No app preload — avoid exposing electron/api bridges on kio.ac.
                plugins: true,
            },
        };
    }

    private buildChromeUserAgent(): string {
        // Match the real Chromium major shipped with this Electron build. A mismatched
        // major (or Windows UA on macOS) is a strong automation signal for Turnstile.
        const chromeVersion = process.versions.chrome || "150.0.0.0";
        if (process.platform === "darwin") {
            return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
        }
        if (process.platform === "win32") {
            return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
        }
        return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    }

    private configureSession(ses: Session, ua: string) {
        ses.setUserAgent(ua);

        const chromeMajor = (process.versions.chrome || "150").split(".")[0] ?? "150";
        const platformHint =
            process.platform === "darwin"
                ? '"macOS"'
                : process.platform === "win32"
                  ? '"Windows"'
                  : '"Linux"';
        // Prefer Google Chrome brand over Chromium/Electron in Client Hints.
        const secChUa = `"Google Chrome";v="${chromeMajor}", "Chromium";v="${chromeMajor}", "Not A(Brand";v="24"`;

        ses.webRequest.onBeforeSendHeaders((details, callback) => {
            const headers = { ...details.requestHeaders };
            headers["User-Agent"] = ua;
            headers["sec-ch-ua"] = secChUa;
            headers["sec-ch-ua-mobile"] = "?0";
            headers["sec-ch-ua-platform"] = platformHint;
            // Drop headers that can fingerprint Electron custom stacks.
            delete headers["X-Electron"];
            callback({ requestHeaders: headers });
        });
    }

    private waitForToken(window: BrowserWindow): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const deadline = Date.now() + TOKEN_TIMEOUT_MS;
            let lastError: string | null = null;
            let timer: NodeJS.Timeout | undefined;
            let settled = false;

            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                window.removeListener("closed", closedHandler);
                window.webContents.removeListener("console-message", consoleHandler);
            };

            const settleResolve = (token: string) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(token);
            };

            const settleReject = (error: unknown) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };

            const closedHandler = () => {
                settleReject(
                    new Error(
                        lastError
                            ? `보안 인증 창이 닫혔습니다 (마지막 오류: ${lastError}).`
                            : "보안 인증 창이 닫혔습니다.",
                    ),
                );
            };
            window.on("closed", closedHandler);

            // Prefer console bridge over dense executeJavaScript polling (CDP-like).
            // Electron 43 supports both the legacy (event, level, message, ...) form and
            // Event<WebContentsConsoleMessageEventParams> with .message on the event.
            const consoleHandler = (...args: unknown[]) => {
                const message = readConsoleMessage(args);
                if (!message) return;
                if (message.startsWith(TOKEN_CONSOLE_PREFIX)) {
                    const token = message.slice(TOKEN_CONSOLE_PREFIX.length);
                    if (token) settleResolve(token);
                    return;
                }
                if (message.startsWith(ERROR_CONSOLE_PREFIX)) {
                    lastError = message.slice(ERROR_CONSOLE_PREFIX.length);
                }
            };
            window.webContents.on("console-message", consoleHandler as never);

            const tick = async () => {
                if (settled || window.isDestroyed()) {
                    return;
                }

                let state: { token: string | null; error: string | null };
                try {
                    state = await window.webContents.executeJavaScript(READ_TOKEN_SCRIPT, true);
                } catch (error) {
                    settleReject(error);
                    return;
                }

                if (state.token) {
                    settleResolve(state.token);
                    return;
                }

                if (state.error) {
                    lastError = state.error;
                }

                if (Date.now() >= deadline) {
                    settleReject(
                        new Error(
                            `보안 인증 시간이 초과되었습니다${
                                lastError ? ` (마지막 오류: ${lastError})` : ""
                            }.`,
                        ),
                    );
                    return;
                }

                timer = setTimeout(tick, POLL_INTERVAL_MS);
            };

            // Sparse fallback poll; console bridge is the primary path.
            timer = setTimeout(tick, POLL_INTERVAL_MS);
        });
    }

    private destroyWindow() {
        const window = this.activeWindow;
        this.activeWindow = null;
        this.activeSession = null;
        if (window && !window.isDestroyed()) {
            window.destroy();
        }
    }
}

function readConsoleMessage(args: unknown[]): string | null {
    if (args.length >= 3 && typeof args[2] === "string") {
        return args[2];
    }
    const first = args[0];
    if (first && typeof first === "object" && "message" in first) {
        const message = (first as { message: unknown }).message;
        if (typeof message === "string") return message;
    }
    return null;
}
