import { setTimeout as sleep } from "node:timers/promises";

import { COLLECTION_INVALID_PASSWORD_ERROR } from "@shared/download-errors";
import { toErrorMessage } from "@shared/utils";

import type { HTTP } from "../../lib/http";

import { formatHttpError, snapshotFailedResponse } from "../../lib/http-error";
import { TransferRateLimitError } from "../transfer-request-pool";

export const MEGA_API_BASE = "https://g.api.mega.co.nz/cs";
export const MEGA_ORIGIN = "https://mega.nz";
export const MEGA_LABEL = "Mega";

export const MEGA_ERROR = {
    EAGAIN: -3,
    ERATELIMIT: -4,
    ENOENT: -9,
    EACCESS: -11,
    EKEY: -14,
    ESID: -15,
    EBLOCKED: -16,
    EOVERQUOTA: -17,
    ETEMPUNAVAIL: -18,
    EMFAREQUIRED: -26,
} as const;

const TRANSIENT_ERROR_CODES = new Set<number>([MEGA_ERROR.EAGAIN, MEGA_ERROR.ETEMPUNAVAIL]);
const TRANSIENT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

let sequence = Math.floor(Math.random() * 0x7fffffff);

export class MegaApiError extends Error {
    public constructor(
        public readonly code: number,
        message: string,
    ) {
        super(message);
        this.name = "MegaApiError";
    }
}

/** The IP's or account's MEGA transfer quota is used up; retrying before `timeLeftMs` cannot succeed. */
export class MegaQuotaExceededError extends Error {
    public constructor(public readonly timeLeftMs?: number) {
        super("Mega 전송 한도를 초과했습니다.");
        this.name = "MegaQuotaExceededError";
    }
}

/** MEGA reports the remaining quota wait in seconds on over-quota CDN responses. */
export function parseMegaTimeLeftMs(headers: Headers) {
    const seconds = Number(headers.get("x-mega-time-left"));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export type MegaApiRequestOptions = {
    apiBase: string;
    origin: string;
    /** Prefix for error messages, e.g. "Transfer" or "Mega". */
    label: string;
    query?: Record<string, string>;
    signal?: AbortSignal;
    rateLimitMessage?: string;
    solveHashcash?: (challenge: string, signal?: AbortSignal) => Promise<string>;
};

export function megaErrorMessage(code: number, label: string) {
    switch (code) {
        case -2:
            return `Invalid ${label.toLowerCase()} arguments.`;
        case MEGA_ERROR.EAGAIN:
            return `${label} API temporarily unavailable. Retry later.`;
        case MEGA_ERROR.ERATELIMIT:
            return `${label} rate limited. Retry later.`;
        case -6:
            return `Too many ${label.toLowerCase()} requests.`;
        case -8:
            return `${label} has expired.`;
        case MEGA_ERROR.ENOENT:
            return `${label} not found.`;
        case MEGA_ERROR.EACCESS:
            return `${label} access denied.`;
        case MEGA_ERROR.EKEY:
            return COLLECTION_INVALID_PASSWORD_ERROR;
        case MEGA_ERROR.ESID:
            return `${label} session is invalid or expired.`;
        case MEGA_ERROR.EBLOCKED:
            return `${label} is blocked.`;
        case MEGA_ERROR.EOVERQUOTA:
            return `${label} bandwidth quota exceeded.`;
        case MEGA_ERROR.ETEMPUNAVAIL:
            return `${label} is temporarily unavailable. Retry later.`;
        case -19:
            return `Too many ${label.toLowerCase()} connections.`;
        case MEGA_ERROR.EMFAREQUIRED:
            return `${label} two-factor authentication code required.`;
        default:
            return `${label} API error (${code}).`;
    }
}

export function isMegaErrorCode(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value < 0;
}

export function assertMegaResult(
    value: unknown,
    stage: string,
    options: Pick<MegaApiRequestOptions, "label" | "rateLimitMessage">,
) {
    if (isMegaErrorCode(value)) {
        throw toMegaError(value, options);
    }
    if (value == null) {
        throw new Error(`${options.label} ${stage} failed: empty response.`);
    }
    return value;
}

export function toMegaError(
    code: number,
    options: Pick<MegaApiRequestOptions, "label" | "rateLimitMessage">,
) {
    if (code === MEGA_ERROR.EOVERQUOTA) {
        return new TransferRateLimitError(undefined, options.rateLimitMessage);
    }
    return new MegaApiError(code, megaErrorMessage(code, options.label));
}

/**
 * Sends one MEGA `/cs` command and returns its raw result (an object or a negative error code).
 * Retries transient EAGAIN/ETEMPUNAVAIL results and answers a single Hashcash (HTTP 402) challenge.
 */
export async function requestMegaApi(
    http: Pick<HTTP, "consumeControlResponse">,
    payload: Record<string, unknown>,
    options: MegaApiRequestOptions,
): Promise<unknown> {
    // MEGA identifies a command by its sequence id: a Hashcash answer is only accepted when it is
    // resent under the id that received the challenge, and retries must not look like new commands.
    const requestId = String((sequence += 1));
    let hashcash: string | undefined;
    let transientRetries = 0;
    for (;;) {
        options.signal?.throwIfAborted();
        const outcome = await sendOnce(http, payload, options, requestId, hashcash);
        if (outcome.type === "hashcash") {
            if (hashcash || !options.solveHashcash) {
                throw new Error(`${options.label} API requires Hashcash challenge (HTTP 402).`);
            }
            hashcash = await options.solveHashcash(outcome.challenge, options.signal);
            continue;
        }
        const delay = TRANSIENT_RETRY_DELAYS_MS[transientRetries];
        if (
            isMegaErrorCode(outcome.result) &&
            TRANSIENT_ERROR_CODES.has(outcome.result) &&
            delay !== undefined
        ) {
            transientRetries += 1;
            await sleep(delay, undefined, { signal: options.signal });
            continue;
        }
        return outcome.result;
    }
}

async function sendOnce(
    http: Pick<HTTP, "consumeControlResponse">,
    payload: Record<string, unknown>,
    options: MegaApiRequestOptions,
    requestId: string,
    hashcash: string | undefined,
): Promise<{ type: "result"; result: unknown } | { type: "hashcash"; challenge: string }> {
    const qs = new URLSearchParams({ id: requestId, ...options.query }).toString();
    return await http.consumeControlResponse(
        `${options.apiBase}?${qs}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "text/plain;charset=UTF-8",
                Origin: options.origin,
                Referer: `${options.origin}/`,
                ...(hashcash ? { "X-Hashcash": hashcash } : {}),
            },
            body: JSON.stringify([payload]),
            signal: options.signal,
        },
        async (response) => {
            if (response.status === 402) {
                const challenge = response.headers.get("x-hashcash");
                await response.body?.cancel().catch(() => undefined);
                if (!challenge) {
                    throw new Error(`${options.label} API requires Hashcash challenge (HTTP 402).`);
                }
                return { type: "hashcash", challenge };
            }
            if (response.status === 509) {
                const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
                await response.body?.cancel().catch(() => undefined);
                throw new TransferRateLimitError(retryAfterMs, options.rateLimitMessage);
            }
            if (!response.ok) {
                throw new Error(
                    formatHttpError(`${options.label} API`, await snapshotFailedResponse(response)),
                );
            }

            const raw = await response.text();
            options.signal?.throwIfAborted();
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                throw new Error(`${options.label} API bad JSON: ${toErrorMessage(error)}`);
            }
            // A bare number is a request-level error; command results come back in an array.
            if (isMegaErrorCode(parsed)) {
                return { type: "result", result: parsed };
            }
            if (!Array.isArray(parsed)) {
                throw new Error(
                    `Unexpected ${options.label} API response: ${JSON.stringify(parsed)}`,
                );
            }
            return { type: "result", result: parsed[0] };
        },
    );
}

export function parseRetryAfterMs(value: string | null) {
    if (!value) {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }
    const date = Date.parse(value);
    if (Number.isNaN(date)) {
        return undefined;
    }
    return Math.max(0, date - Date.now());
}
