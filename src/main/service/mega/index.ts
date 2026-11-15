import type { Worker } from "node:worker_threads";

import type { MegaAccountState, MegaLoginPayload, MegaLoginResult } from "@shared/types";
import { safeStorage } from "electron";
import pLimit from "p-limit";

import type { KioskDownloader } from "../..";

import { logCaughtError } from "../../lib/logged-error";
// electron-vite rewrites this into a Worker factory in the bundled main process.
import createHashcashWorker from "./hashcash-worker?nodeWorker";
import {
    isMegaErrorCode,
    MEGA_API_BASE,
    MEGA_ERROR,
    MEGA_LABEL,
    MEGA_ORIGIN,
    MegaApiError,
    megaErrorMessage,
    requestMegaApi,
    toMegaError,
} from "./mega-api";
import {
    decryptMegaMasterKey,
    decryptMegaSessionId,
    deriveMegaV1Credentials,
    deriveMegaV2Credentials,
} from "./mega-auth";

const SESSION_STATE_KEY = "mega.session";

type StoredSession = { sid: string; email: string };

type AccountSnapshot = Extract<MegaAccountState, { loggedIn: true }>;

export class MegaAccountService {
    private session: StoredSession | null = null;
    private account: AccountSnapshot | null = null;
    private sessionGeneration = 0;
    private readonly controlPlane = pLimit(4);
    private readonly hashcashWorkers = new Set<Worker>();

    public constructor(private readonly kd: KioskDownloader) {}

    public get generation() {
        return this.sessionGeneration;
    }

    public getSessionId() {
        return this.session?.sid;
    }

    /** Loads the persisted session without a network round trip; it is validated in the background. */
    public async restoreSession() {
        const stored = await this.kd.lib.db.appState.getValue(SESSION_STATE_KEY);
        if (!stored || !safeStorage.isEncryptionAvailable()) {
            return;
        }
        try {
            const session = JSON.parse(
                safeStorage.decryptString(Buffer.from(stored, "base64")),
            ) as StoredSession;
            if (typeof session.sid !== "string" || typeof session.email !== "string") {
                throw new Error("Invalid stored Mega session.");
            }
            this.session = session;
        } catch (error) {
            logCaughtError(this.kd.logger, "MegaAccountService:restoreSession", {}, error);
            await this.kd.lib.db.appState.delete(SESSION_STATE_KEY);
            return;
        }
        this.sessionGeneration += 1;
        void this.refreshAccount().catch((error: unknown) => {
            logCaughtError(this.kd.logger, "MegaAccountService:validateSession", {}, error);
        });
    }

    public getAccount(): MegaAccountState {
        const persistent = safeStorage.isEncryptionAvailable();
        if (!this.session) {
            return { loggedIn: false, persistent };
        }
        return (
            this.account ?? {
                loggedIn: true,
                persistent,
                email: this.session.email,
                proLevel: 0,
            }
        );
    }

    public async login(payload: MegaLoginPayload): Promise<MegaLoginResult> {
        const email = payload.email.trim().toLowerCase();
        let stage = "us0";
        try {
            const prelogin = (await this.api({ a: "us0", user: email }, stage)) as {
                v?: number;
                s?: string;
            };
            const credentials =
                prelogin.v === 2 && prelogin.s
                    ? deriveMegaV2Credentials(payload.password, prelogin.s)
                    : deriveMegaV1Credentials(email, payload.password);

            stage = "us";
            const mfaCode = payload.mfaCode?.trim();
            const result = await this.rawApi({
                a: "us",
                user: email,
                uh: credentials.userHash,
                ...(mfaCode ? { mfa: mfaCode } : {}),
            });
            if (result === MEGA_ERROR.EMFAREQUIRED) {
                return { status: "mfaRequired" };
            }
            if (isMegaErrorCode(result)) {
                throw result === -9 || result === MEGA_ERROR.EKEY
                    ? new MegaApiError(result, "Mega 이메일 또는 비밀번호가 올바르지 않습니다.")
                    : toMegaError(result, { label: MEGA_LABEL });
            }
            const login = result as {
                k?: string;
                csid?: string;
                privk?: string;
                tsid?: string;
                u?: string;
            };

            stage = "session";
            if (!login.k || (!login.tsid && (!login.csid || !login.privk || !login.u))) {
                throw new Error("Mega login response is missing session data.");
            }
            const masterKey = decryptMegaMasterKey(login.k, credentials.passwordKey);
            const sid =
                login.tsid ?? decryptMegaSessionId(login.csid!, login.privk!, masterKey, login.u!);

            await this.setSession({ sid, email });
        } catch (error) {
            logCaughtError(this.kd.logger, "MegaAccountService:login", { stage }, error);
            throw error;
        }
        // Login already succeeded; account details are informational and can be refreshed later.
        const account = await this.refreshAccount().catch((error: unknown) => {
            logCaughtError(this.kd.logger, "MegaAccountService:login", { stage: "ug" }, error);
            return this.getAccount();
        });
        return { status: "ok", account };
    }

    public async logout() {
        const sid = this.session?.sid;
        if (sid) {
            await this.rawApi({ a: "sml" }, sid).catch((error: unknown) => {
                logCaughtError(this.kd.logger, "MegaAccountService:logout", {}, error);
            });
        }
        await this.clearSession();
        return this.getAccount();
    }

    public async refreshAccount(): Promise<MegaAccountState> {
        const session = this.session;
        if (!session) {
            return this.getAccount();
        }
        const user = (await this.api({ a: "ug" }, "ug")) as { email?: string; name?: string };
        const quota = (await this.api({ a: "uq", xfer: 1, pro: 1 }, "uq")) as {
            utype?: number;
            mxfer?: number;
            caxfer?: number;
            csxfer?: number;
        };
        if (this.session !== session) {
            return this.getAccount();
        }
        this.account = {
            loggedIn: true,
            persistent: safeStorage.isEncryptionAvailable(),
            email: user.email ?? session.email,
            ...(user.name ? { name: user.name } : {}),
            proLevel: quota.utype ?? 0,
            ...(typeof quota.caxfer === "number" || typeof quota.csxfer === "number"
                ? { transferUsedBytes: (quota.caxfer ?? 0) + (quota.csxfer ?? 0) }
                : {}),
            ...(typeof quota.mxfer === "number" ? { transferMaxBytes: quota.mxfer } : {}),
        };
        this.emitChanged();
        return this.account;
    }

    /** Called when an API request made with the current session reports ESID. */
    public async invalidateSession(sid: string) {
        if (this.session?.sid !== sid) {
            return;
        }
        this.kd.logger.warn({}, "MegaAccountService:sessionExpired");
        await this.clearSession();
    }

    public solveHashcash(challenge: string, signal?: AbortSignal) {
        return new Promise<string>((resolve, reject) => {
            signal?.throwIfAborted();
            const worker = createHashcashWorker({ workerData: challenge });
            this.hashcashWorkers.add(worker);
            const finish = () => {
                signal?.removeEventListener("abort", onAbort);
                this.hashcashWorkers.delete(worker);
                worker.removeAllListeners();
                void worker.terminate().catch(() => undefined);
            };
            const onAbort = () => {
                finish();
                reject(signal?.reason);
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            worker.once(
                "message",
                (message: { ok: boolean; header?: string; message?: string }) => {
                    finish();
                    if (message.ok && message.header) {
                        resolve(message.header);
                        return;
                    }
                    reject(new Error(message.message ?? "Hashcash worker failed."));
                },
            );
            worker.once("error", (error) => {
                finish();
                reject(error);
            });
        });
    }

    public destroy() {
        for (const worker of this.hashcashWorkers) {
            void worker.terminate().catch(() => undefined);
        }
        this.hashcashWorkers.clear();
    }

    private async setSession(session: StoredSession) {
        this.session = session;
        this.account = null;
        this.sessionGeneration += 1;
        if (safeStorage.isEncryptionAvailable()) {
            await this.kd.lib.db.appState.upsert(
                SESSION_STATE_KEY,
                safeStorage.encryptString(JSON.stringify(session)).toString("base64"),
                new Date().toISOString(),
            );
        }
        this.emitChanged();
    }

    private async clearSession() {
        this.session = null;
        this.account = null;
        this.sessionGeneration += 1;
        await this.kd.lib.db.appState.delete(SESSION_STATE_KEY);
        this.emitChanged();
    }

    private emitChanged() {
        this.kd.ipc.broadcast("mega:accountChanged", this.getAccount());
    }

    /** Account API call with the current session; ESID logs the session out. */
    private async api(payload: Record<string, unknown>, stage: string) {
        const sid = payload.a === "us0" ? undefined : this.session?.sid;
        const result = await this.rawApi(payload, sid);
        if (result === MEGA_ERROR.ESID && sid) {
            await this.invalidateSession(sid);
        }
        if (isMegaErrorCode(result)) {
            throw new MegaApiError(result, `${megaErrorMessage(result, MEGA_LABEL)} (${stage})`);
        }
        return result;
    }

    private rawApi(payload: Record<string, unknown>, sid?: string) {
        return this.controlPlane(() =>
            requestMegaApi(this.kd.http, payload, {
                apiBase: MEGA_API_BASE,
                origin: MEGA_ORIGIN,
                label: MEGA_LABEL,
                query: sid ? { sid } : {},
                solveHashcash: (challenge, signal) => this.solveHashcash(challenge, signal),
            }),
        );
    }
}
