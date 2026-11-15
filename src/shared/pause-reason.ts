import type { DownloadPauseReason } from "./types";

/** When MEGA gave no wait time, a quota-paused download is retried after this long. */
export const MEGA_QUOTA_RETRY_MS = 30 * 60_000;

/** When an automatic resume of a quota-paused collection is due (ms epoch). */
export function getAutoResumeTime(reason: DownloadPauseReason) {
    return reason.resumeAt ?? reason.pausedAt + MEGA_QUOTA_RETRY_MS;
}
