import http from "node:http";
import type { AddressInfo } from "node:net";

import { BROWSER_EXTENSION_API_PREFIX } from "@shared/browser-extension";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";

import { BrowserExtensionService } from ".";

const showMessageBox = vi.hoisted(() =>
    vi.fn<() => Promise<{ response: number; checkboxChecked: boolean }>>(),
);

vi.mock("electron", () => ({
    app: { getVersion: () => "1.0.0" },
    dialog: { showMessageBox },
}));

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const servers = new Set<http.Server>();

afterEach(async () => {
    for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers.clear();
    showMessageBox.mockReset();
});

const SAVE_PATH = "C:\\Downloads";

async function createFixture() {
    const notify = vi.fn();
    const download = {
        prepare: vi.fn(async () => ({
            status: "ready" as const,
            draftId: "draft-1",
            collection: { name: "Share" },
        })),
        create: vi.fn(async () => ({ collection: { name: "Share" } })),
        listZipEntries: vi.fn(async () => ({ status: "ready" as const, entries: [] })),
        discardDraft: vi.fn(),
        getExtensionDraftSavePath: vi.fn(() => SAVE_PATH),
    };
    const settings: Record<string, unknown> = {
        "general.browserExtensionAllowedIds": [ORIGIN.slice("chrome-extension://".length)],
        "general.lastDownloadPath": SAVE_PATH,
    };
    const service = new BrowserExtensionService({
        setting: {
            get: async (key: string) => settings[key],
            set: async (key: string, value: unknown) => {
                settings[key] = value;
            },
        },
        window: { main: { createMainWindow: async () => undefined } },
        ipc: { sendToMainWindow: notify },
        logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        service: { download },
    } as unknown as KioskDownloader);
    const handler = service as unknown as {
        handle: (
            req: http.IncomingMessage,
            res: http.ServerResponse,
            port: number,
        ) => Promise<void>;
    };
    const server = http.createServer((req, res) => {
        void handler.handle(req, res, (server.address() as AddressInfo).port);
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        service,
        notify,
        download,
        settings,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${BROWSER_EXTENSION_API_PREFIX}`,
    };
}

describe("browser extension HTTP API", () => {
    it("reports an approved extension as paired using a POST ping", async () => {
        const fixture = await createFixture();
        const response = await fetch(`${fixture.url}/ping`, {
            method: "POST",
            headers: { Origin: ORIGIN },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ paired: true });
    });

    it.each([undefined, "https://example.com"])(
        "rejects a POST ping with an untrusted origin (%s)",
        async (origin) => {
            const fixture = await createFixture();
            const response = await fetch(`${fixture.url}/ping`, {
                method: "POST",
                headers: origin ? { Origin: origin } : {},
            });

            expect(response.status).toBe(403);
        },
    );

    it("rejects an unsupported intercepted URL without enqueueing any items", async () => {
        const fixture = await createFixture();
        const response = await fetch(`${fixture.url}/requests`, {
            method: "POST",
            headers: { Origin: ORIGIN, "Content-Type": "application/json" },
            body: JSON.stringify({
                items: [
                    { url: "https://example.com/file.zip", source: "intercept" },
                    { url: "https://f12.workupload.com/download/FileKey", source: "intercept" },
                ],
            }),
        });

        expect(response.status).toBe(400);
        expect(fixture.service.takeRequests()).toEqual([]);
        expect(fixture.notify).not.toHaveBeenCalled();
    });

    it("accepts supported and encoded links with their request headers", async () => {
        const fixture = await createFixture();
        const items = [
            {
                url: "https://example.com/file.zip",
                headers: { referer: "https://example.com/files", cookie: "session=value" },
                source: "intercept",
            },
            {
                url: Buffer.from("https://workupload.com/file/FileKey").toString("base64"),
                source: "link",
            },
        ];
        const response = await fetch(`${fixture.url}/requests`, {
            method: "POST",
            headers: { Origin: ORIGIN, "Content-Type": "application/json" },
            body: JSON.stringify({ items }),
        });

        expect(response.status).toBe(202);
        expect(fixture.service.takeRequests()).toEqual([
            items[0],
            { ...items[1], url: "https://workupload.com/file/FileKey" },
        ]);
    });

    it("rejects popover routes from an untrusted origin without touching downloads", async () => {
        const fixture = await createFixture();
        for (const route of ["/prepare", "/start", "/pair"]) {
            const response = await fetch(`${fixture.url}${route}`, {
                method: "POST",
                headers: { Origin: "https://example.com", "Content-Type": "application/json" },
                body: JSON.stringify({ url: "https://workupload.com/file/FileKey" }),
            });
            expect(response.status).toBe(403);
        }
        expect(fixture.download.prepare).not.toHaveBeenCalled();
        expect(fixture.download.create).not.toHaveBeenCalled();
    });

    it("prepares a decoded link, lists ZIP entries, and starts it with ZIP passwords", async () => {
        const fixture = await createFixture();
        const post = (route: string, body: unknown) =>
            fetch(`${fixture.url}${route}`, {
                method: "POST",
                headers: { Origin: ORIGIN, "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

        const prepared = await post("/prepare", {
            url: Buffer.from("https://workupload.com/file/FileKey").toString("base64"),
        });
        expect(await prepared.json()).toMatchObject({ status: "ready", savePath: SAVE_PATH });
        expect(fixture.download.prepare).toHaveBeenCalledWith(
            expect.objectContaining({ url: "https://workupload.com/file/FileKey" }),
            "extension",
        );

        const zipRequest = { draftId: "draft-1", fileId: "zip-1", zipPassword: "secret" };
        const listed = await post("/zip-entries", zipRequest);
        expect(await listed.json()).toEqual({ status: "ready", entries: [] });
        expect(fixture.download.listZipEntries).toHaveBeenCalledWith(zipRequest);

        fixture.settings["general.lastDownloadPath"] = "C:\\OtherDownloads";

        const started = await post("/start", {
            draftId: "draft-1",
            selectedPaths: ["a.zip", "a.zip/inner.txt"],
            zipPasswords: { "zip-1": "secret" },
        });
        expect(await started.json()).toEqual({ name: "Share" });
        expect(fixture.download.create).toHaveBeenCalledWith({
            draftId: "draft-1",
            savePath: SAVE_PATH,
            selectedPaths: ["a.zip", "a.zip/inner.txt"],
            zipPasswords: { "zip-1": "secret" },
        });
    });

    it("responds while pairing is pending and authorizes only after approval", async () => {
        const fixture = await createFixture();
        fixture.settings["general.browserExtensionAllowedIds"] = [];
        let approve!: () => void;
        showMessageBox.mockImplementation(
            () =>
                new Promise((resolve) => {
                    approve = () => resolve({ response: 0, checkboxChecked: false });
                }),
        );
        let response: Response | undefined;
        const pairing = fetch(`${fixture.url}/pair`, {
            method: "POST",
            headers: { Origin: ORIGIN, "Content-Type": "application/json" },
            body: "{}",
        }).then((value) => {
            response = value;
            return value;
        });
        try {
            await vi.waitFor(() => expect(response?.status).toBe(202));
            const ping = await fetch(`${fixture.url}/ping`, {
                method: "POST",
                headers: { Origin: ORIGIN },
            });
            expect(await ping.json()).toMatchObject({ paired: false });
            const request = await fetch(`${fixture.url}/requests`, {
                method: "POST",
                headers: { Origin: ORIGIN, "Content-Type": "application/json" },
                body: JSON.stringify({
                    items: [{ url: "https://example.com/a.bin", source: "link" }],
                }),
            });
            expect(request.status).toBe(409);
            expect(fixture.service.takeRequests()).toEqual([]);
        } finally {
            approve();
            await pairing;
        }
        await vi.waitFor(() =>
            expect(fixture.settings["general.browserExtensionAllowedIds"]).toContain(
                ORIGIN.slice("chrome-extension://".length),
            ),
        );
    });

    it("keeps a pairing denial until an explicit retry", async () => {
        const fixture = await createFixture();
        fixture.settings["general.browserExtensionAllowedIds"] = [];
        showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
        const pair = (retryDenied = false) =>
            fetch(`${fixture.url}/pair`, {
                method: "POST",
                headers: { Origin: ORIGIN, "Content-Type": "application/json" },
                body: JSON.stringify({ retryDenied }),
            });
        expect((await pair()).status).toBe(202);
        await vi.waitFor(async () => {
            const ping = await fetch(`${fixture.url}/ping`, {
                method: "POST",
                headers: { Origin: ORIGIN },
            });
            expect(await ping.json()).toMatchObject({ paired: false, pairingDenied: true });
        });
        expect((await pair()).status).toBe(403);
        expect(showMessageBox).toHaveBeenCalledTimes(1);

        showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
        expect((await pair(true)).status).toBe(202);
        await vi.waitFor(() =>
            expect(fixture.settings["general.browserExtensionAllowedIds"]).toContain(
                ORIGIN.slice("chrome-extension://".length),
            ),
        );
        expect(showMessageBox).toHaveBeenCalledTimes(2);
    });
});
