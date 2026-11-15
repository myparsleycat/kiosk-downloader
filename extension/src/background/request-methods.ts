const MAX_URLS = 1024;
const GET_TTL_MS = 60_000;

export function createRequestMethodGuard() {
    const startedAt = Date.now();
    const gets = new Map<string, number>();
    const nonGets = new Set<string>();
    let saturated = false;

    function observe(
        details: Pick<chrome.webRequest.OnBeforeRequestDetails, "url" | "method">,
    ): undefined {
        if (saturated) return;
        if (details.method !== "GET") {
            gets.delete(details.url);
            if (nonGets.size >= MAX_URLS && !nonGets.has(details.url)) {
                saturated = true;
                gets.clear();
                nonGets.clear();
                return;
            }
            // Completion does not prove that a delayed download has finished using this URL.
            nonGets.add(details.url);
            return;
        }
        if (nonGets.has(details.url)) return;
        gets.delete(details.url);
        gets.set(details.url, Date.now());
        if (gets.size > MAX_URLS) {
            const oldest = gets.keys().next().value;
            if (oldest !== undefined) gets.delete(oldest);
        }
    }

    function isGetDownload(item: chrome.downloads.DownloadItem) {
        const downloadStartedAt = Date.parse(item.startTime);
        // A fresh worker has no method history for downloads that were already in progress.
        if (saturated || !Number.isFinite(downloadStartedAt) || downloadStartedAt < startedAt) {
            return false;
        }
        return isGetUrl(item.url) && isGetUrl(item.finalUrl || item.url);
    }

    function isGetUrl(url: string) {
        const observedAt = gets.get(url);
        if (observedAt === undefined || nonGets.has(url)) return false;
        const age = Date.now() - observedAt;
        if (age < 0 || age >= GET_TTL_MS) {
            gets.delete(url);
            return false;
        }
        return true;
    }

    return { observe, isGetDownload };
}
