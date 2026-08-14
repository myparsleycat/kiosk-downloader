import {
    REQUEST_POOL_SIZE_MAX,
    REQUEST_POOL_SIZE_MIN,
    type TransferDirection,
    type TransferProviderRequestId,
} from "@shared/settings";

export type TransferRequestContext = {
    collectionId: string;
    direction: TransferDirection;
    providerId: TransferProviderRequestId;
    signal?: AbortSignal;
};

export type TransferRateLimitState = {
    consecutiveRateLimits: number;
    cooldownMs: number;
    isNewEpisode: boolean;
    terminal: boolean;
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
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    onAbort?: () => void;
};

type CollectionState = {
    key: string;
    providerId: TransferProviderRequestId;
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

const KIOSK_UPLOAD_HARD_CAP = 8;
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

    public constructor(poolSize: number) {
        this.poolSize = clampPoolSize(poolSize);
    }

    public resize(poolSize: number) {
        this.poolSize = clampPoolSize(poolSize);
        this.drain();
    }

    public async runPayload<T>(context: TransferRequestContext, task: () => Promise<T>) {
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
                error.state = this.registerRateLimit(context, error.retryAfterMs);
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
        const release = await this.acquire(context);
        try {
            if (context.signal?.aborted) {
                throw abortReason(context.signal);
            }
            yield* task();
            this.registerSuccess(context);
        } catch (error) {
            if (error instanceof TransferRateLimitError) {
                error.state = this.registerRateLimit(context, error.retryAfterMs);
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

    /** @deprecated Use runPayload so completion and provider feedback remain atomic. */
    public acquire(context: TransferRequestContext) {
        if (context.signal?.aborted) {
            return Promise.reject(abortReason(context.signal));
        }
        validateDirection(context);

        const key = collectionKey(context);
        const collection = this.collections.get(key) ?? this.registerCollection(key, context);

        return new Promise<() => void>((resolve, reject) => {
            const request: PendingRequest = {
                order: this.nextRequestOrder,
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
                    this.drain();
                };
                context.signal.addEventListener("abort", request.onAbort, { once: true });
            }

            collection.pending.push(request);
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
            providerId: context.providerId,
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

    private drain() {
        while (this.inFlight < this.poolSize) {
            const collection = [...this.collections.values()]
                .filter((candidate) => this.canGrant(candidate))
                .sort(compareFairness)[0];
            if (!collection) {
                return;
            }

            const request = collection.pending.shift()!;
            if (request.onAbort) {
                request.signal?.removeEventListener("abort", request.onAbort);
            }
            collection.inFlight += 1;
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
                collection.inFlight -= 1;
                this.inFlight -= 1;
                this.providerInFlight.set(
                    collection.providerId,
                    (this.providerInFlight.get(collection.providerId) ?? 1) - 1,
                );
                this.drain();
            });
        }
    }

    private canGrant(collection: CollectionState) {
        if (collection.pending.length === 0 || Date.now() < collection.cooldownUntil) {
            return false;
        }
        if (
            collection.providerId === "kiosk-upload" &&
            (this.providerInFlight.get("kiosk-upload") ?? 0) >= KIOSK_UPLOAD_HARD_CAP
        ) {
            return false;
        }
        if (
            collection.providerId === "transfer-it-download" &&
            collection.inFlight >= collection.transferTarget
        ) {
            return false;
        }
        return true;
    }

    private registerSuccess(context: TransferRequestContext) {
        if (context.providerId !== "transfer-it-download") {
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

    private registerRateLimit(context: TransferRequestContext, retryAfterMs?: number) {
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
}

function collectionKey(context: TransferRequestContext) {
    return `${context.direction}\0${context.providerId}\0${context.collectionId}`;
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

function compareFairness(left: CollectionState, right: CollectionState) {
    return (
        left.lastGranted - right.lastGranted ||
        left.registrationOrder - right.registrationOrder ||
        (left.pending[0]?.order ?? 0) - (right.pending[0]?.order ?? 0)
    );
}
