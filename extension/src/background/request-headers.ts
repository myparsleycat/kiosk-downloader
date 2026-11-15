import type { BrowserExtensionRequestItem } from "@shared/browser-extension";

// Matches the app's limit for a single direct-download header value.
const MAX_HEADER_LENGTH = 8 * 1024;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Builds the headers the app replays when it fetches a direct URL outside the browser. */
export async function buildDirectRequestHeaders(
    url: string,
    referrer: string | undefined,
): Promise<NonNullable<BrowserExtensionRequestItem["headers"]>> {
    return {
        referer: referrer ? buildReferer(referrer, url) : undefined,
        cookie: await buildCookieHeader(url),
        userAgent: navigator.userAgent,
    };
}

// Applies the browser's default strict-origin-when-cross-origin policy, since a page's own
// Referrer-Policy header is not visible to the extension. Page URLs from content scripts may carry
// fragments and credentials that browsers never send.
function buildReferer(referrer: string, url: string) {
    const source = URL.parse(referrer);
    const target = URL.parse(url);
    if (!source || !target || (source.protocol !== "http:" && source.protocol !== "https:")) {
        return undefined;
    }
    if (source.protocol === "https:" && target.protocol !== "https:") return undefined;
    if (source.origin !== target.origin) return `${source.origin}/`;
    source.hash = "";
    source.username = "";
    source.password = "";
    return source.href;
}

async function buildCookieHeader(url: string) {
    const cookies = await chrome.cookies.getAll({ url });
    let header = "";
    for (const cookie of cookies) {
        const pair = `${cookie.name}=${cookie.value}`;
        // The app rejects non-ASCII header values outright, so drop such cookies instead.
        if (!PRINTABLE_ASCII.test(pair)) continue;
        const next = header ? `${header}; ${pair}` : pair;
        if (next.length > MAX_HEADER_LENGTH) break;
        header = next;
    }
    return header || undefined;
}
