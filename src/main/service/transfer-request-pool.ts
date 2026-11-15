import {
    REQUEST_POOL_SIZE_MAX,
    REQUEST_POOL_SIZE_MIN,
    type TransferDirection,
    type TransferProviderRequestId,
} from "@shared/settings";
import type { RequestPoolUsage } from "@shared/types";

export type TransferRequestContext = {
    collectionId: string;
    direction: TransferDirection;
    providerId: TransferProviderRequestId;
    /** Host of the URL being requested; direct downloads share a concurrency limit per host. */
    host?: string;
    signal?: AbortSignal;
};

export type TransferRateLimitState = {
    consecutiveRateLimits: number;
    cooldownMs: number;
    isNewEpisode: boolean;
    terminal: boolean;
    hostLimit?: number;
};

export class TransferRateLimitError extends Error {
    public state?: TransferRateLimitState;

    public constructor(
        public readonly retryAfterMs?: number,
        message = "Transfer 서버가 다운로드 요청을 제한했습니다. 잠시 후 다시 시도해 주세요.",
    ) {
        super(message);
        this.name = "TransferRateLimitError";
    }
}

type PendingRequest = {
    order: number;
    host: string | null;
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    onAbort?: () => void;
};

export type RequestPoolUsageChange = {
    direction: TransferDirection;
    providerId: TransferProviderRequestId;
    collectionId: string;
};

type CollectionState = {
    key: string;
    direction: TransferDirection;
    collectionId: string;
    providerId: TransferProviderRequestId;
    host: string | null;
    registrationOrder: number;
    lastGranted: number;
    inFlight: number;
    pending: PendingRequest[];
    transferTarget: number;
    transferSuccesses: number;
    consecutiveRateLimits: number;
    cooldownUntil: number;
    cooldownTimer: ReturnType<typeof setTimeout> | null;
};

type HostState = {
    key: string;
    limit: number;
    inFlight: number;
    cooldownUntil: number;
    cooldownTimer: ReturnType<typeof setTimeout> | null;
    consecutiveRejections: number;
    lastRejectedAt: number;
    lastRaisedAt: number;
    probeIntervalMs: number;
};

const KIOSK_UPLOAD_HARD_CAP = 8;
// Many plain HTTP servers throttle or reject more than a handful of parallel ranges per client.
const DIRECT_DOWNLOAD_CONNECTIONS_PER_HOST = 8;
const HOST_LIMIT_PROBE_INTERVAL_MS = 30_000;
const HOST_LIMIT_PROBE_INTERVAL_MAX_MS = 600_000;
const HOST_REJECTION_STREAK_GAP_MS = 10_000;
const TRANSFER_SUCCESSES_PER_INCREASE = 2;
const TRANSFER_RATE_LIMIT_DELAYS_MS = [2000, 5000, 10000] as const;

export class TransferScheduler {
    private poolSize: number;
    private inFlight = 0;
    private nextRegistrationOrder = 0;
    private nextRequestOrder = 0;
    private nextGrantOrder = 0;
    private readonly providerInFlight = new Map<TransferProviderRequestId, number>();
    private readonly collections = new Map<string, CollectionState>();
    private readonly hosts = new Map<string, HostState>();

    public constructor(
        poolSize: number,
        private readonly onUsageChange?: (change: RequestPoolUsageChange) => void,
    ) {
        this.poolSize = clampPoolSize(poolSize);
    }

    public resize(poolSize: number) {
        this.poolSize = clampPoolSize(poolSize);
        this.drain();
    }

    public async runPayload<T>(context: TransferRequestContext, task: () => Promise<T>) {
        const requestedAt = Date.now();
        const release = await this.acquire(context);
        try {
            if (context.signal?.aborted) {
                throw abortReason(context.signal);
            }
            const result = await task();
            this.registerSuccess(context);
            return result;
        } catch (error) {
            if (error instanceof TransferRateLimitError) {
                error.state = this.registerRateLimit(context, error.retryAfterMs, requestedAt);
            }
            throw error;
        } finally {
            release();
        }
    }

    public async *runPayloadStream<T>(
        context: TransferRequestContext,
        task: () => AsyncGenerator<T>,
    ): AsyncGenerator<T> {
        const requestedAt = Date.now();
        const release = await this.acquire(context);
        try {
            if (context.signal?.aborted) {
                throw abortReason(context.signal);
            }
            yield* task();
            this.registerSuccess(context);
        } catch (error) {
            if (error instanceof TransferRateLimitError) {
                error.state = this.registerRateLimit(context, error.retryAfterMs, requestedAt);
            }
            throw error;
        } finally {
            release();
        }
    }

    public reportRateLimit(context: TransferRequestContext, error: TransferRateLimitError) {
        validateDirection(context);
        const key = collectionKey(context);
        if (!this.collections.has(key)) {
            this.registerCollection(key, context);
        }
        error.state = this.registerRateLimit(context, error.retryAfterMs);
        return error.state;
    }

    public getCollectionUsage(context: TransferRequestContext): RequestPoolUsage | null {
        const collection = this.collections.get(collectionKey(context));
        if (!collection) {
            return null;
        }
        const usage = { inFlight: collection.inFlight, pending: collection.pending.length };
        const host = collection.host ? this.hosts.get(collection.host) : undefined;
        return host ? { ...usage, limit: host.limit } : usage;
    }

    /** @deprecated Use runPayload so completion and provider feedback remain atomic. */
    public acquire(context: TransferRequestContext) {
        if (context.signal?.aborted) {
            return Promise.reject(abortReason(context.signal));
        }
        validateDirection(context);

        const key = collectionKey(context);
        const collection = this.collections.get(key) ?? this.registerCollection(key, context);
        const host = this.ensureHost(context);
        if (host) {
            collection.host = host.key;
        }

        return new Promise<() => void>((resolve, reject) => {
            const request: PendingRequest = {
                order: this.nextRequestOrder,
                host: host?.key ?? null,
                signal: context.signal,
                resolve,
                reject,
            };
            this.nextRequestOrder += 1;

            if (context.signal) {
                request.onAbort = () => {
                    const index = collection.pending.indexOf(request);
                    if (index < 0) {
                        return;
                    }
                    collection.pending.splice(index, 1);
                    request.signal?.removeEventListener("abort", request.onAbort!);
                    request.reject(abortReason(request.signal!));
                    this.onUsageChange?.(usageChange(collection));
                    this.drain();
                };
                context.signal.addEventListener("abort", request.onAbort, { once: true });
            }

            collection.pending.push(request);
            this.onUsageChange?.(usageChange(collection));
            this.drain();
        });
    }

    /** @deprecated Use runPayload. */
    public run<T>(context: TransferRequestContext, task: () => Promise<T>) {
        return this.runPayload(context, task);
    }

    private registerCollection(key: string, context: TransferRequestContext) {
        const collection: CollectionState = {
            key,
            direction: context.direction,
            collectionId: context.collectionId,
            providerId: context.providerId,
            host: null,
            registrationOrder: this.nextRegistrationOrder,
            lastGranted: -1,
            inFlight: 0,
            pending: [],
            transferTarget: 1,
            transferSuccesses: 0,
            consecutiveRateLimits: 0,
            cooldownUntil: 0,
            cooldownTimer: null,
        };
        this.nextRegistrationOrder += 1;
        this.collections.set(key, collection);
        return collection;
    }

    private ensureHost(context: TransferRequestContext) {
        const key = hostKey(context);
        if (key === null) {
            return null;
        }
        const existing = this.hosts.get(key);
        if (existing) {
            return existing;
        }
        const host: HostState = {
            key,
            limit: DIRECT_DOWNLOAD_CONNECTIONS_PER_HOST,
            inFlight: 0,
            cooldownUntil: 0,
            cooldownTimer: null,
            consecutiveRejections: 0,
            lastRejectedAt: 0,
            lastRaisedAt: 0,
            probeIntervalMs: HOST_LIMIT_PROBE_INTERVAL_MS,
        };
        this.hosts.set(key, host);
        return host;
    }

    private drain() {
        while (this.inFlight < this.poolSize) {
            const candidate = [...this.collections.values()]
                .map((collection) => ({ collection, index: this.grantableIndex(collection) }))
                .filter((entry) => entry.index >= 0)
                .sort(compareFairness)[0];
            if (!candidate) {
                return;
            }

            const collection = candidate.collection;
            const request = collection.pending.splice(candidate.index, 1)[0];
            if (request.onAbort) {
                request.signal?.removeEventListener("abort", request.onAbort);
            }
            const host = request.host ? this.hosts.get(request.host) : undefined;
            if (host) {
                host.inFlight += 1;
            }
            collection.inFlight += 1;
            this.onUsageChange?.(usageChange(collection));
            collection.lastGranted = this.nextGrantOrder;
            this.nextGrantOrder += 1;
            this.inFlight += 1;
            this.providerInFlight.set(
                collection.providerId,
                (this.providerInFlight.get(collection.providerId) ?? 0) + 1,
            );

            let released = false;
            request.resolve(() => {
                if (released) {
                    return;
                }
                released = true;
                if (host) {
                    host.inFlight -= 1;
                }
                collection.inFlight -= 1;
                this.onUsageChange?.(usageChange(collection));
                this.inFlight -= 1;
                this.providerInFlight.set(
                    collection.providerId,
                    (this.providerInFlight.get(collection.providerId) ?? 1) - 1,
                );
                this.drain();
            });
        }
    }

    // Picks the first pending request whose host has room, so a saturated or cooling host does
    // not hold back the collection's requests to other hosts.
    private grantableIndex(collection: CollectionState) {
        const now = Date.now();
        if (collection.pending.length === 0 || now < collection.cooldownUntil) {
            return -1;
        }
        if (
            collection.providerId === "kiosk-upload" &&
            (this.providerInFlight.get("kiosk-upload") ?? 0) >= KIOSK_UPLOAD_HARD_CAP
        ) {
            return -1;
        }
        if (
            (collection.providerId === "transfer-it-download" ||
                collection.providerId === "mega-download") &&
            collection.inFlight >= collection.transferTarget
        ) {
            return -1;
        }
        return collection.pending.findIndex((request) => {
            if (request.host === null) {
                return true;
            }
            const host = this.hosts.get(request.host)!;
            return host.inFlight < host.limit && now >= host.cooldownUntil;
        });
    }

    // Only providers that report rate limits keep an adaptive target; a success ends the
    // current rate-limit streak so isolated throttling never becomes terminal.
    private registerSuccess(context: TransferRequestContext) {
        const host = this.ensureHost(context);
        if (host) {
            this.registerHostSuccess(host);
            return;
        }
        if (
            context.providerId !== "transfer-it-download" &&
            context.providerId !== "mega-download"
        ) {
            return;
        }
        const collection = this.collections.get(collectionKey(context));
        if (!collection) {
            return;
        }
        if (Date.now() < collection.cooldownUntil) {
            return;
        }
        collection.consecutiveRateLimits = 0;
        collection.transferSuccesses += 1;
        if (collection.transferSuccesses < TRANSFER_SUCCESSES_PER_INCREASE) {
            return;
        }
        collection.transferSuccesses = 0;
        collection.transferTarget = Math.min(REQUEST_POOL_SIZE_MAX, collection.transferTarget + 1);
    }

    private registerRateLimit(
        context: TransferRequestContext,
        retryAfterMs?: number,
        requestedAt = Date.now(),
    ) {
        const host = this.ensureHost(context);
        if (host) {
            return this.registerHostRejection(host, requestedAt, retryAfterMs);
        }
        const collection = this.collections.get(collectionKey(context));
        if (!collection) {
            throw new Error("Transfer collection state is missing");
        }
        const now = Date.now();
        const isNewEpisode = now >= collection.cooldownUntil;
        if (isNewEpisode) {
            collection.consecutiveRateLimits += 1;
            collection.transferTarget = 1;
            collection.transferSuccesses = 0;
            const cooldownMs = Math.max(
                TRANSFER_RATE_LIMIT_DELAYS_MS[
                    Math.min(
                        collection.consecutiveRateLimits - 1,
                        TRANSFER_RATE_LIMIT_DELAYS_MS.length - 1,
                    )
                ],
                retryAfterMs ?? 0,
            );
            collection.cooldownUntil = now + cooldownMs;
            if (collection.cooldownTimer) {
                clearTimeout(collection.cooldownTimer);
            }
            collection.cooldownTimer = setTimeout(() => {
                collection.cooldownTimer = null;
                this.drain();
            }, cooldownMs);
        }
        return {
            consecutiveRateLimits: collection.consecutiveRateLimits,
            cooldownMs: Math.max(0, collection.cooldownUntil - now),
            isNewEpisode,
            terminal: collection.consecutiveRateLimits >= 3,
        } satisfies TransferRateLimitState;
    }

    // Called before the rejected request releases its permit, so inFlight still counts it: the
    // server accepted at most inFlight - 1 concurrent requests. Each rejection in a burst lowers
    // the limit by one more, converging on what the server allows. Only a rejection of a lone
    // request (or an explicit Retry-After) is real throttling that pauses the host and counts
    // toward the terminal streak; otherwise the rejected chunk retries at once within the limit.
    private registerHostRejection(
        host: HostState,
        requestedAt: number,
        retryAfterMs?: number,
    ): TransferRateLimitState {
        const now = Date.now();
        // Only a rejection within one interval of a raise blames that probe. Clearing
        // lastRaisedAt makes the rest of the same burst count once and marks the probe as failed.
        if (host.lastRaisedAt > 0 && now - host.lastRaisedAt < host.probeIntervalMs) {
            host.probeIntervalMs = Math.min(
                HOST_LIMIT_PROBE_INTERVAL_MAX_MS,
                host.probeIntervalMs * 2,
            );
            host.lastRaisedAt = 0;
        }
        host.lastRejectedAt = now;
        const lowered = Math.max(1, Math.min(host.limit, host.inFlight - 1));
        if (lowered !== host.limit) {
            host.limit = lowered;
            this.notifyHostUsage(host);
        }

        const throttled = host.inFlight <= 1 || retryAfterMs !== undefined;
        const isNewEpisode = throttled && now >= host.cooldownUntil;
        if (isNewEpisode) {
            // Chunk retries are queued right as a cooldown ends, though they may wait longer for a
            // permit; a request queued well after it is a fresh download or a user retry, which
            // must not inherit the streak that already failed earlier work.
            if (requestedAt - host.cooldownUntil > HOST_REJECTION_STREAK_GAP_MS) {
                host.consecutiveRejections = 0;
            }
            host.consecutiveRejections += 1;
            const cooldownMs = Math.max(
                TRANSFER_RATE_LIMIT_DELAYS_MS[
                    Math.min(
                        host.consecutiveRejections - 1,
                        TRANSFER_RATE_LIMIT_DELAYS_MS.length - 1,
                    )
                ],
                retryAfterMs ?? 0,
            );
            host.cooldownUntil = now + cooldownMs;
            if (host.cooldownTimer) {
                clearTimeout(host.cooldownTimer);
            }
            host.cooldownTimer = setTimeout(() => {
                host.cooldownTimer = null;
                this.drain();
            }, cooldownMs);
        }
        return {
            consecutiveRateLimits: host.consecutiveRejections,
            cooldownMs: Math.max(0, host.cooldownUntil - now),
            isNewEpisode,
            terminal: throttled && host.consecutiveRejections >= 3,
            hostLimit: host.limit,
        };
    }

    // Probes one extra connection at a time, only while the host is saturated and only after a
    // quiet interval, so a server's limit is relearned without ramping straight back into the
    // rejections that lowered it. The interval doubles when a probe is rejected and halves when
    // the previous probe held, so isolated blips do not pin a host to the maximum interval.
    private registerHostSuccess(host: HostState) {
        const now = Date.now();
        if (now < host.cooldownUntil) {
            return;
        }
        host.consecutiveRejections = 0;
        if (
            host.limit >= DIRECT_DOWNLOAD_CONNECTIONS_PER_HOST ||
            host.inFlight < host.limit ||
            now - Math.max(host.lastRejectedAt, host.lastRaisedAt) < host.probeIntervalMs
        ) {
            return;
        }
        if (host.lastRaisedAt > 0) {
            host.probeIntervalMs = Math.max(HOST_LIMIT_PROBE_INTERVAL_MS, host.probeIntervalMs / 2);
        }
        host.limit += 1;
        host.lastRaisedAt = now;
        this.notifyHostUsage(host);
    }

    private notifyHostUsage(host: HostState) {
        for (const collection of this.collections.values()) {
            if (collection.host === host.key) {
                this.onUsageChange?.(usageChange(collection));
            }
        }
    }
}

function collectionKey(context: TransferRequestContext) {
    return `${context.direction}\0${context.providerId}\0${context.collectionId}`;
}

function hostKey(context: TransferRequestContext) {
    if (context.providerId !== "direct-download") {
        return null;
    }
    if (!context.host) {
        throw new Error("Direct download requests must specify the host they connect to");
    }
    return context.host;
}

function usageChange(collection: CollectionState): RequestPoolUsageChange {
    return {
        direction: collection.direction,
        providerId: collection.providerId,
        collectionId: collection.collectionId,
    };
}

function validateDirection(context: TransferRequestContext) {
    const expectedDirection = context.providerId === "kiosk-upload" ? "upload" : "download";
    if (expectedDirection === context.direction) {
        return;
    }
    throw new Error(
        `Transfer provider ${context.providerId} cannot run in the ${context.direction} direction`,
    );
}

function clampPoolSize(poolSize: number) {
    return Math.min(REQUEST_POOL_SIZE_MAX, Math.max(REQUEST_POOL_SIZE_MIN, Math.floor(poolSize)));
}

function abortReason(signal: AbortSignal) {
    return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

// Permits are held for a whole payload and never preempted, so the collection holding the fewest
// must win every freed permit until it catches up; grant recency alone only breaks ties.
type GrantCandidate = { collection: CollectionState; index: number };

function compareFairness(left: GrantCandidate, right: GrantCandidate) {
    return (
        left.collection.inFlight - right.collection.inFlight ||
        left.collection.lastGranted - right.collection.lastGranted ||
        left.collection.registrationOrder - right.collection.registrationOrder ||
        left.collection.pending[left.index].order - right.collection.pending[right.index].order
    );
}
