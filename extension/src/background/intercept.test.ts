import { setImmediate } from "node:timers/promises";

import type { SendResult } from "@ext/shared/messages";
import { DEFAULT_SETTINGS } from "@ext/shared/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConnection, launchApp, sendItems } from "./app-client";

vi.mock("./app-client", () => ({
    getConnection: vi.fn(),
    launchApp: vi.fn(),
    sendItems: vi.fn(),
}));

type FilenameListener = Parameters<typeof chrome.downloads.onDeterminingFilename.addListener>[0];
type RequestListener = Parameters<typeof chrome.webRequest.onBeforeRequest.addListener>[0];
type HeadersListener = Parameters<typeof chrome.webRequest.onHeadersReceived.addListener>[0];

const chromeMock = {
    webRequest: {
        onBeforeRequest: { addListener: vi.fn<(listener: RequestListener) => void>() },
        onHeadersReceived: { addListener: vi.fn<(listener: HeadersListener) => void>() },
    },
    downloads: {
        onDeterminingFilename: { addListener: vi.fn<(listener: FilenameListener) => void>() },
        cancel: vi.fn<(id: number) => Promise<void>>(),
        erase: vi.fn<(query: chrome.downloads.DownloadQuery) => Promise<number[]>>(),
        download: vi.fn<(options: chrome.downloads.DownloadOptions) => Promise<number>>(),
    },
    storage: {
        sync: { get: vi.fn(async () => ({ settings: interceptEnabledSettings() })) },
    },
    cookies: { getAll: vi.fn(async () => []) },
};

const item: chrome.downloads.DownloadItem = {
    id: 42,
    url: "https://files.example/download?id=1",
    finalUrl: "https://cdn.example/archive.zip",
    referrer: "https://forum.example/thread/1",
    filename: "archive.zip",
    mime: "application/zip",
    totalBytes: 1024,
    fileSize: 1024,
    bytesReceived: 0,
    startTime: "2026-11-14T00:00:00.000Z",
    state: "in_progress",
    paused: false,
    canResume: false,
    incognito: false,
    danger: "safe",
    exists: false,
};

beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(item.startTime));
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("navigator", { userAgent: "Kioex Test" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    chromeMock.storage.sync.get.mockResolvedValue({ settings: interceptEnabledSettings() });
    chromeMock.cookies.getAll.mockResolvedValue([]);
    chromeMock.downloads.cancel.mockResolvedValue(undefined);
    chromeMock.downloads.erase.mockResolvedValue([item.id]);
    chromeMock.downloads.download.mockResolvedValue(43);
    vi.mocked(getConnection).mockResolvedValue({
        state: "connected",
        port: 1,
        version: "test",
        protocol: 2,
    });
    vi.mocked(sendItems).mockResolvedValue({ ok: true });
    (await import("./intercept")).registerDownloadInterception();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("download interception", () => {
    it("keeps the original download and suggests its filename when handoff is rejected", async () => {
        observeGetDownload();
        vi.mocked(sendItems).mockResolvedValue({ ok: false, reason: "failed" });

        const suggest = await determineFilename();

        expect.soft(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect.soft(chromeMock.downloads.erase).not.toHaveBeenCalled();
        expect.soft(chromeMock.downloads.download).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
        expect(sendItems).toHaveBeenCalledOnce();
    });

    it("keeps the original download and suggests its filename when handoff throws", async () => {
        observeGetDownload();
        vi.mocked(sendItems).mockRejectedValue(new Error("connection lost"));

        const suggest = await determineFilename();

        expect.soft(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect.soft(chromeMock.downloads.erase).not.toHaveBeenCalled();
        expect.soft(chromeMock.downloads.download).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
        expect(sendItems).toHaveBeenCalledOnce();
    });

    it("keeps the original download when launching the app fails", async () => {
        observeGetDownload();
        const settings = interceptEnabledSettings();
        settings.intercept.launchApp = true;
        chromeMock.storage.sync.get.mockResolvedValue({ settings });
        vi.mocked(getConnection).mockResolvedValue({ state: "offline" });
        vi.mocked(launchApp).mockResolvedValue({ state: "offline" });

        const suggest = await determineFilename();

        expect.soft(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect.soft(chromeMock.downloads.erase).not.toHaveBeenCalled();
        expect.soft(chromeMock.downloads.download).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
        expect(sendItems).not.toHaveBeenCalled();
        expect(launchApp).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it("cancels and erases only after a successful acknowledgement", async () => {
        observeGetDownload();
        let acknowledge!: (result: SendResult) => void;
        vi.mocked(sendItems).mockReturnValue(
            new Promise<SendResult>((resolve) => {
                acknowledge = resolve;
            }),
        );
        const suggest = await determineFilename();

        expect(sendItems).toHaveBeenCalledExactlyOnceWith([
            {
                url: item.finalUrl,
                headers: {
                    referer: "https://forum.example/",
                    cookie: undefined,
                    userAgent: "Kioex Test",
                },
                source: "intercept",
            },
        ]);
        expect.soft(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect.soft(chromeMock.downloads.erase).not.toHaveBeenCalled();
        expect(suggest).not.toHaveBeenCalled();

        acknowledge({ ok: true });
        await setImmediate();

        expect(chromeMock.downloads.cancel).toHaveBeenCalledExactlyOnceWith(item.id);
        expect(chromeMock.downloads.erase).toHaveBeenCalledExactlyOnceWith({ id: item.id });
        expect(chromeMock.downloads.cancel).toHaveBeenCalledBefore(chromeMock.downloads.erase);
        expect(chromeMock.downloads.download).not.toHaveBeenCalled();
        expect(suggest).not.toHaveBeenCalled();
    });

    it.each(["POST", "PUT", "HEAD"])("preserves the original %s download", async (method) => {
        observeRequest(item.url, method);
        observeRequest(item.finalUrl, method, "headers");

        const suggest = await determineFilename();

        expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect(chromeMock.downloads.erase).not.toHaveBeenCalled();
        expect(sendItems).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
    });

    it.each(["neither", "original", "final"])(
        "preserves downloads with incomplete GET observations: %s",
        async (observed) => {
            if (observed === "original") observeRequest(item.url, "GET");
            if (observed === "final") observeRequest(item.finalUrl, "GET", "headers");

            const suggest = await determineFilename();

            expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
            expect(sendItems).not.toHaveBeenCalled();
            expect(suggest).toHaveBeenCalledExactlyOnceWith();
        },
    );

    it.each([
        ["original", "before"],
        ["original", "headers"],
        ["final", "before"],
        ["final", "headers"],
    ] as const)("preserves mixed GET/POST downloads on the %s URL at %s", async (url, phase) => {
        observeGetDownload();
        observeRequest(url === "original" ? item.url : item.finalUrl, "POST", phase);
        observeGetDownload();

        const suggest = await determineFilename();

        expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect(sendItems).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
    });

    it("preserves POST-to-GET redirects", async () => {
        observeRequest(item.url, "POST");
        observeRequest(item.finalUrl, "GET", "headers");

        const suggest = await determineFilename();

        expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect(sendItems).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
    });

    it("preserves downloads after GET observations expire", async () => {
        observeGetDownload();
        vi.mocked(Date.now).mockReturnValue(Date.parse(item.startTime) + 60_000);

        const suggest = await determineFilename();

        expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect(sendItems).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
    });

    it("preserves downloads after GET observations are evicted", async () => {
        observeGetDownload();
        for (let index = 0; index < 2048; index++) {
            observeRequest(`https://files.example/other/${index}`, "GET");
        }

        const suggest = await determineFilename();

        expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect(sendItems).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
    });

    it("retains POST ambiguity across TTL expiry, GET eviction and later GET observations", async () => {
        observeRequest(item.url, "POST");
        vi.mocked(Date.now).mockReturnValue(Date.parse(item.startTime) + 60_001);
        for (let index = 0; index < 2048; index++) {
            observeRequest(`https://files.example/other/${index}`, "GET");
        }
        observeGetDownload();

        const suggest = await determineFilename();

        expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect(sendItems).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
    });

    it("fails closed when retained non-GET observations fill the safety metadata", async () => {
        for (let index = 0; index < 1025; index++) {
            observeRequest(`https://files.example/export/${index}`, "POST");
        }
        observeGetDownload();

        const suggest = await determineFilename();

        expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect(sendItems).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
    });

    it("preserves downloads started before a worker restart even with new GET observations", async () => {
        observeRequest(item.url, "POST");
        vi.resetModules();
        chromeMock.webRequest.onBeforeRequest.addListener.mockClear();
        chromeMock.webRequest.onHeadersReceived.addListener.mockClear();
        chromeMock.downloads.onDeterminingFilename.addListener.mockClear();
        vi.mocked(Date.now).mockReturnValue(Date.parse(item.startTime) + 1);
        (await import("./intercept")).registerDownloadInterception();
        observeGetDownload();

        const suggest = await determineFilename();

        expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect(sendItems).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
    });

    it.each(["POST", "GET expiry"])(
        "preserves the original when %s occurs before sending to the app",
        async (change) => {
            observeGetDownload();
            let resolveCookies!: () => void;
            chromeMock.cookies.getAll.mockReturnValue(
                new Promise((resolve) => {
                    resolveCookies = () => resolve([]);
                }),
            );
            const suggest = await determineFilename();

            if (change === "POST") observeRequest(item.finalUrl, "POST", "headers");
            else vi.mocked(Date.now).mockReturnValue(Date.parse(item.startTime) + 60_000);
            resolveCookies();
            await setImmediate();

            expect(sendItems).not.toHaveBeenCalled();
            expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
            expect(chromeMock.downloads.erase).not.toHaveBeenCalled();
            expect(suggest).toHaveBeenCalledExactlyOnceWith();
        },
    );

    it.each(["POST", "GET expiry"])(
        "commits an accepted handoff despite %s while awaiting app acknowledgement",
        async (change) => {
            observeGetDownload();
            let acknowledge!: (result: SendResult) => void;
            vi.mocked(sendItems).mockReturnValue(
                new Promise<SendResult>((resolve) => {
                    acknowledge = resolve;
                }),
            );
            const suggest = await determineFilename();
            expect(sendItems).toHaveBeenCalledOnce();

            if (change === "POST") observeRequest(item.finalUrl, "POST", "headers");
            else vi.mocked(Date.now).mockReturnValue(Date.parse(item.startTime) + 60_000);
            acknowledge({ ok: true });
            await setImmediate();

            expect(chromeMock.downloads.cancel).toHaveBeenCalledExactlyOnceWith(item.id);
            expect(chromeMock.downloads.erase).toHaveBeenCalledExactlyOnceWith({ id: item.id });
            expect(suggest).not.toHaveBeenCalled();
        },
    );

    it("preserves downloads whose pre-redirect host is excluded", async () => {
        const settings = interceptEnabledSettings();
        settings.intercept.excludedHosts = ["files.example"];
        chromeMock.storage.sync.get.mockResolvedValue({ settings });
        observeGetDownload();

        const suggest = await determineFilename();

        expect(sendItems).not.toHaveBeenCalled();
        expect(chromeMock.downloads.cancel).not.toHaveBeenCalled();
        expect(suggest).toHaveBeenCalledExactlyOnceWith();
    });
});

function interceptEnabledSettings() {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.intercept.enabled = true;
    return settings;
}

async function determineFilename() {
    const suggest = vi.fn();
    expect(
        chromeMock.downloads.onDeterminingFilename.addListener.mock.calls[0][0](item, suggest),
    ).toBe(true);
    await setImmediate();
    return suggest;
}

function observeGetDownload() {
    observeRequest(item.url, "GET");
    observeRequest(item.finalUrl, "GET", "headers");
}

function observeRequest(url: string, method: string, phase: "before" | "headers" = "before") {
    const details: chrome.webRequest.OnHeadersReceivedDetails = {
        url,
        method,
        requestId: `${method}:${url}`,
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        frameType: "outermost_frame",
        documentLifecycle: "active",
        type: "main_frame",
        timeStamp: Date.now(),
        statusCode: 200,
        statusLine: "HTTP/1.1 200 OK",
    };
    const event =
        phase === "before"
            ? chromeMock.webRequest.onBeforeRequest
            : chromeMock.webRequest.onHeadersReceived;
    event.addListener.mock.calls[0]?.[0](details);
}
