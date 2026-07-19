export const SPEED_EMA_TAU_MS = 1500;

type ByteSample = { t: number; b: number };

export class TransferSpeedSampler {
    private readonly samplesByKey = new Map<string, ByteSample[]>();
    private readonly speedByKey = new Map<string, number>();
    private readonly lastEmaAtByKey = new Map<string, number>();

    public constructor(
        private readonly now: () => number,
        private readonly windowMs: number,
        private readonly minSampleSpanMs = 500,
        private readonly emaTauMs = SPEED_EMA_TAU_MS,
    ) {}

    public get(key: string) {
        return this.speedByKey.get(key) ?? 0;
    }

    public sample(key: string, totalBytes: number) {
        const now = this.now();
        const samples = this.samplesByKey.get(key) ?? [];
        samples.push({ t: now, b: totalBytes });
        const window = samples.filter((sample) => now - sample.t <= this.windowMs);
        this.samplesByKey.set(key, window);

        if (window.length < 2) {
            return this.cachedOrClearIfStale(now, key);
        }

        const first = window[0];
        const last = window[window.length - 1];
        const elapsedMs = last.t - first.t;
        if (elapsedMs < this.minSampleSpanMs) {
            return this.cachedOrClearIfStale(now, key);
        }

        const instantBps = Math.max(0, (last.b - first.b) / (elapsedMs / 1000));
        const lastEmaAt = this.lastEmaAtByKey.get(key);
        const speedBps = updateSpeedEma(
            this.speedByKey.get(key),
            instantBps,
            lastEmaAt === undefined ? Number.POSITIVE_INFINITY : now - lastEmaAt,
            this.emaTauMs,
        );
        this.speedByKey.set(key, speedBps);
        this.lastEmaAtByKey.set(key, now);
        return speedBps;
    }

    public clear(key: string) {
        this.samplesByKey.delete(key);
        this.speedByKey.delete(key);
        this.lastEmaAtByKey.delete(key);
    }

    private cachedOrClearIfStale(now: number, key: string) {
        return cachedSpeedOrClearIfStale(
            now,
            key,
            this.speedByKey,
            this.lastEmaAtByKey,
            this.windowMs,
        );
    }
}

export function updateSpeedEma(
    prevEma: number | undefined,
    instantBps: number,
    dtMs: number,
    tauMs: number,
): number {
    if (prevEma === undefined) {
        return instantBps;
    }
    if (dtMs <= 0) {
        return prevEma;
    }

    const alpha = 1 - Math.exp(-dtMs / tauMs);
    return alpha * instantBps + (1 - alpha) * prevEma;
}

/** When the window is unmeasurable, keep the cached EMA unless the last update is older than the speed window. */
export function cachedSpeedOrClearIfStale(
    now: number,
    key: string,
    speedByKey: Map<string, number>,
    lastEmaAtByKey: Map<string, number>,
    staleAfterMs: number,
): number {
    const lastEmaAt = lastEmaAtByKey.get(key);
    if (lastEmaAt !== undefined && now - lastEmaAt > staleAfterMs) {
        speedByKey.delete(key);
        lastEmaAtByKey.delete(key);
        return 0;
    }
    return speedByKey.get(key) ?? 0;
}
