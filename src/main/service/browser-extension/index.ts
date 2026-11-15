import http from "node:http";
import path from "node:path";

import { logCaughtError } from "@main/lib/logged-error";
import {
    BROWSER_EXTENSION_API_PREFIX,
    BROWSER_EXTENSION_APP_NAME,
    BROWSER_EXTENSION_PORTS,
    BROWSER_EXTENSION_PROTOCOL_VERSION,
    browserExtensionDiscardSchema,
    type BrowserExtensionErrorCode,
    type BrowserExtensionErrorResponse,
    type BrowserExtensionPingResponse,
    browserExtensionPairSchema,
    browserExtensionPrepareSchema,
    type BrowserExtensionPrepareResponse,
    type BrowserExtensionRequestItem,
    browserExtensionRequestSchema,
    type BrowserExtensionServerStatus,
    browserExtensionStartSchema,
    type BrowserExtensionStartResponse,
    browserExtensionZipEntriesSchema,
    DEEP_LINK_SCHEME,
    parseExtensionOrigin,
} from "@shared/browser-extension";
import { tryDecodeShareUrlBase64 } from "@shared/share-url";
import { app, dialog } from "electron";

import type { KioskDownloader } from "../..";

import { authorizeExtensionRequest, isLoopbackHost } from "./authorize";

// Start requests list every selected path, which for large collections exceeds 1 MiB.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_ITEMS = 500;
const AUTHORIZED_ROUTES = [
    "/pair",
    "/requests",
    "/prepare",
    "/start",
    "/zip-entries",
    "/discard",
] as const;

class PayloadTooLargeError extends Error {}

export class BrowserExtensionService {
    private readonly kd: KioskDownloader;
    private server: http.Server | null = null;
    private port: number | null = null;
    private lastError: string | null = null;
    private pending: BrowserExtensionRequestItem[] = [];
    private readonly deniedIds = new Set<string>();
    private readonly pairingPrompts = new Map<string, Promise<boolean>>();
    // listen() only assigns the server after the bind completes, so enabling and stopping run one
    // at a time to keep a stop from missing a server that is still binding.
    private transition: Promise<void> = Promise.resolve();

    constructor(kd: KioskDownloader) {
        this.kd = kd;
    }

    public async start() {
        await this.setEnabled(await this.kd.setting.get("general.browserExtension"));
    }

    public setEnabled(enabled: boolean) {
        return this.enqueueTransition(async () => {
            if (!enabled) {
                this.unregisterProtocol();
                await this.closeServer();
                return;
            }
            this.registerProtocol();
            await this.listen();
        });
    }

    public stop() {
        return this.enqueueTransition(() => this.closeServer());
    }

    private enqueueTransition(run: () => Promise<void>) {
        const next = this.transition.then(run);
        // The caller receives the failure through `next`; the queue only needs to keep going.
        this.transition = next.catch(() => undefined);
        return next;
    }

    private async closeServer() {
        const server = this.server;
        this.server = null;
        this.port = null;
        if (!server) return;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    public getStatus(): BrowserExtensionServerStatus {
        return { enabled: this.server != null, port: this.port, error: this.lastError };
    }

    public takeRequests() {
        const items = this.pending;
        this.pending = [];
        return items;
    }

    private async listen() {
        if (this.server) return;

        for (const port of BROWSER_EXTENSION_PORTS) {
            const server = http.createServer((req, res) => void this.handle(req, res, port));
            try {
                await listenOnLoopback(server, port);
            } catch (error) {
                if (isAddressUnavailable(error)) continue;
                this.lastError = error instanceof Error ? error.message : String(error);
                logCaughtError(this.kd.logger, "BrowserExtension:listen", { port }, error);
                return;
            }
            server.on("error", (error) =>
                logCaughtError(this.kd.logger, "BrowserExtension:server", { port }, error),
            );
            this.server = server;
            this.port = port;
            this.lastError = null;
            this.kd.logger.info({ port }, "BrowserExtension:listen");
            return;
        }

        this.lastError = `사용 가능한 포트가 없습니다 (${BROWSER_EXTENSION_PORTS.join(", ")}).`;
        this.kd.logger.error({ ports: BROWSER_EXTENSION_PORTS }, "BrowserExtension:listen");
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse, port: number) {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        const origin = req.headers.origin;
        let stage = "route";
        try {
            if (parseExtensionOrigin(origin)) {
                res.setHeader("Access-Control-Allow-Origin", origin!);
                res.setHeader("Vary", "Origin");
            }

            if (req.method === "OPTIONS") {
                this.handlePreflight(req, res, port);
                return;
            }
            const route = pathname.startsWith(BROWSER_EXTENSION_API_PREFIX)
                ? pathname.slice(BROWSER_EXTENSION_API_PREFIX.length)
                : null;
            if (req.method === "POST" && route === "/ping") {
                await this.handlePing(req, res, port);
                return;
            }
            if (req.method !== "POST" || !isAuthorizedRoute(route)) {
                sendError(res, 404, "notFound");
                return;
            }

            stage = "authorize";
            if (route === "/pair") {
                await this.handlePair(req, res, port);
                return;
            }
            if (!(await this.authorize(req, res, port))) return;

            stage = "read-body";
            if (!isJsonContentType(req.headers["content-type"])) {
                sendError(res, 415, "unsupportedMediaType");
                return;
            }
            const body = await readJsonBody(req);

            stage = route;
            if (route === "/requests") {
                await this.handleRequests(res, body);
                return;
            }
            if (route === "/prepare") {
                await this.handlePrepare(res, body);
                return;
            }
            if (route === "/start") {
                await this.handleStart(res, body);
                return;
            }
            if (route === "/zip-entries") {
                await this.handleZipEntries(res, body);
                return;
            }
            this.handleDiscard(res, body);
        } catch (error) {
            if (error instanceof PayloadTooLargeError) {
                sendError(res, 413, "payloadTooLarge");
                return;
            }
            if (error instanceof SyntaxError) {
                sendError(res, 400, "invalidRequest");
                return;
            }
            logCaughtError(
                this.kd.logger,
                "BrowserExtension:handle",
                { stage, method: req.method, pathname, origin, port },
                error,
            );
            if (!res.headersSent) {
                res.statusCode = 500;
            }
            res.end();
        }
    }

    private async handleRequests(res: http.ServerResponse, body: unknown) {
        const parsed = browserExtensionRequestSchema.safeParse(body);
        if (!parsed.success) {
            sendError(res, 400, "invalidRequest");
            return;
        }
        await this.enqueue(
            parsed.data.items.map((item) => ({
                ...item,
                url: tryDecodeShareUrlBase64(item.url) ?? item.url,
            })),
        );
        sendJson(res, 202, { accepted: parsed.data.items.length });
    }

    private async handlePrepare(res: http.ServerResponse, body: unknown) {
        const parsed = browserExtensionPrepareSchema.safeParse(body);
        if (!parsed.success) {
            sendError(res, 400, "invalidRequest");
            return;
        }
        const result = await this.kd.service.download.prepare(
            {
                url: tryDecodeShareUrlBase64(parsed.data.url) ?? parsed.data.url,
                headers: parsed.data.headers,
                password: parsed.data.password,
            },
            "extension",
        );
        const response: BrowserExtensionPrepareResponse =
            result.status === "ready"
                ? {
                      ...result,
                      savePath: this.kd.service.download.getExtensionDraftSavePath(result.draftId),
                  }
                : result;
        sendJson(res, 200, response);
    }

    private async handleStart(res: http.ServerResponse, body: unknown) {
        const parsed = browserExtensionStartSchema.safeParse(body);
        if (!parsed.success) {
            sendError(res, 400, "invalidRequest");
            return;
        }
        try {
            // DownloadService.create logs its own failures with the draft and save path.
            const item = await this.kd.service.download.create({
                draftId: parsed.data.draftId,
                savePath: this.kd.service.download.getExtensionDraftSavePath(parsed.data.draftId),
                selectedPaths: parsed.data.selectedPaths,
                zipPasswords: parsed.data.zipPasswords,
            });
            sendJson(res, 200, {
                name: item.collection.name,
            } satisfies BrowserExtensionStartResponse);
        } catch (error) {
            sendOperationFailed(res, error);
        }
    }

    private async handleZipEntries(res: http.ServerResponse, body: unknown) {
        const parsed = browserExtensionZipEntriesSchema.safeParse(body);
        if (!parsed.success) {
            sendError(res, 400, "invalidRequest");
            return;
        }
        try {
            // DownloadService.listZipEntries logs unexpected indexing failures itself.
            sendJson(res, 200, await this.kd.service.download.listZipEntries(parsed.data));
        } catch (error) {
            sendOperationFailed(res, error);
        }
    }

    private handleDiscard(res: http.ServerResponse, body: unknown) {
        const parsed = browserExtensionDiscardSchema.safeParse(body);
        if (!parsed.success) {
            sendError(res, 400, "invalidRequest");
            return;
        }
        this.kd.service.download.discardDraft({ draftId: parsed.data.draftId });
        res.writeHead(204);
        res.end();
    }

    private handlePreflight(req: http.IncomingMessage, res: http.ServerResponse, port: number) {
        if (!isLoopbackHost(req.headers.host, port) || !parseExtensionOrigin(req.headers.origin)) {
            sendError(res, 403, "forbidden");
            return;
        }
        res.writeHead(204, {
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Private-Network": "true",
            "Access-Control-Max-Age": "600",
        });
        res.end();
    }

    private async handlePing(req: http.IncomingMessage, res: http.ServerResponse, port: number) {
        const authorization = await this.getAuthorization(req, port);
        if (authorization.status === "rejected" && authorization.reason !== "denied") {
            sendError(res, 403, "forbidden");
            return;
        }
        sendJson(res, 200, {
            app: BROWSER_EXTENSION_APP_NAME,
            version: app.getVersion(),
            protocol: BROWSER_EXTENSION_PROTOCOL_VERSION,
            paired: authorization.status === "ok",
            pairingDenied: authorization.status === "rejected" && authorization.reason === "denied",
        } satisfies BrowserExtensionPingResponse);
    }

    private async getAuthorization(req: http.IncomingMessage, port: number) {
        return authorizeExtensionRequest({
            host: req.headers.host,
            origin: req.headers.origin,
            port,
            allowedIds: await this.kd.setting.get("general.browserExtensionAllowedIds"),
            deniedIds: this.deniedIds,
        });
    }

    private async authorize(req: http.IncomingMessage, res: http.ServerResponse, port: number) {
        const authorization = await this.getAuthorization(req, port);
        if (authorization.status === "ok") return true;
        if (authorization.status === "rejected") {
            sendError(res, 403, authorization.reason === "denied" ? "pairingDenied" : "forbidden");
            return false;
        }
        sendError(res, 409, "pairingRequired");
        return false;
    }

    private async handlePair(req: http.IncomingMessage, res: http.ServerResponse, port: number) {
        const authorization = await this.getAuthorization(req, port);
        if (authorization.status === "rejected" && authorization.reason !== "denied") {
            sendError(res, 403, "forbidden");
            return;
        }
        if (authorization.status === "ok") {
            sendJson(res, 200, { paired: true });
            return;
        }
        if (!isJsonContentType(req.headers["content-type"])) {
            sendError(res, 415, "unsupportedMediaType");
            return;
        }
        const parsed = browserExtensionPairSchema.safeParse(await readJsonBody(req));
        if (!parsed.success) {
            sendError(res, 400, "invalidRequest");
            return;
        }
        if (authorization.status === "rejected" && !parsed.data.retryDenied) {
            sendError(res, 403, "pairingDenied");
            return;
        }
        const extensionId = parseExtensionOrigin(req.headers.origin)!;
        this.deniedIds.delete(extensionId);
        // The extension polls ping while this dialog is open, so no HTTP response waits on the user.
        void this.requestPairing(extensionId).catch((error) => {
            this.deniedIds.add(extensionId);
            logCaughtError(this.kd.logger, "BrowserExtension:pair", { extensionId }, error);
        });
        sendJson(res, 202, { paired: false });
    }

    private requestPairing(extensionId: string) {
        const existing = this.pairingPrompts.get(extensionId);
        if (existing) return existing;

        const prompt = this.promptPairing(extensionId).finally(() =>
            this.pairingPrompts.delete(extensionId),
        );
        this.pairingPrompts.set(extensionId, prompt);
        return prompt;
    }

    private async promptPairing(extensionId: string) {
        const window = await this.kd.window.main.createMainWindow();
        const options = {
            type: "question" as const,
            buttons: ["허용", "거부"],
            defaultId: 1,
            cancelId: 1,
            title: "브라우저 확장 프로그램 연결",
            message: "브라우저 확장 프로그램이 Kiosk Downloader에 연결하려고 합니다.",
            detail: `확장 프로그램 ID: ${extensionId}\n\n허용하면 이 확장 프로그램이 다운로드 링크를 보낼 수 있습니다. 직접 설치한 kioex 확장 프로그램이 아니라면 거부하세요.`,
        };
        const result =
            window && !window.isDestroyed()
                ? await dialog.showMessageBox(window, options)
                : await dialog.showMessageBox(options);

        if (result.response !== 0) {
            this.deniedIds.add(extensionId);
            this.kd.logger.warn({ extensionId }, "BrowserExtension:pairingDenied");
            return false;
        }

        const allowedIds = await this.kd.setting.get("general.browserExtensionAllowedIds");
        await this.kd.setting.set("general.browserExtensionAllowedIds", [
            ...allowedIds,
            extensionId,
        ]);
        this.kd.logger.info({ extensionId }, "BrowserExtension:paired");
        return true;
    }

    private async enqueue(items: BrowserExtensionRequestItem[]) {
        this.pending = [...this.pending, ...items].slice(-MAX_PENDING_ITEMS);
        await this.kd.window.main.createMainWindow();
        this.kd.ipc.sendToMainWindow("browserExtension:requestsAvailable");
    }

    private registerProtocol() {
        const target = protocolClientTarget();
        const registered = app.setAsDefaultProtocolClient(
            DEEP_LINK_SCHEME,
            target.path,
            target.args,
        );
        if (!registered) {
            this.kd.logger.warn({ scheme: DEEP_LINK_SCHEME }, "BrowserExtension:registerProtocol");
        }
    }

    private unregisterProtocol() {
        const target = protocolClientTarget();
        app.removeAsDefaultProtocolClient(DEEP_LINK_SCHEME, target.path, target.args);
    }
}

function protocolClientTarget(): { path?: string; args?: string[] } {
    // The portable build runs from a temporary extraction folder; the protocol must point at the
    // original portable executable, which stays in place between runs.
    const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portableExecutable) {
        return { path: portableExecutable, args: [] };
    }
    if (process.defaultApp && process.argv.length >= 2) {
        return { path: process.execPath, args: [path.resolve(process.argv[1])] };
    }
    return {};
}

function listenOnLoopback(server: http.Server, port: number) {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function isAddressUnavailable(error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EADDRINUSE" || code === "EACCES";
}

function isAuthorizedRoute(route: string | null): route is (typeof AUTHORIZED_ROUTES)[number] {
    return (AUTHORIZED_ROUTES as readonly (string | null)[]).includes(route);
}

function isJsonContentType(value: string | undefined) {
    return value?.split(";")[0].trim().toLowerCase() === "application/json";
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) {
            throw new PayloadTooLargeError();
        }
        chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

function sendOperationFailed(res: http.ServerResponse, error: unknown) {
    sendJson(res, 422, {
        error: "operationFailed",
        message: error instanceof Error ? error.message : String(error),
    } satisfies BrowserExtensionErrorResponse);
}

function sendError(res: http.ServerResponse, status: number, error: BrowserExtensionErrorCode) {
    sendJson(res, status, { error });
}
