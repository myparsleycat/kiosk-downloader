export const SPEED_EMA_TAU_MS = 1500;

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
