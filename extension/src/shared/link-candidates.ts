import { tryDecodeShareUrlBase64, tryParseDownloadUrl } from "@shared/share-url";

import type { LinkProvider } from "./settings";

export type CandidateFilter = {
    providers: Record<LinkProvider, boolean>;
    directExtensions: readonly string[];
    decodeLinks: boolean;
};

export type LinkCandidate = { url: string; provider: LinkProvider };

// Shortest supported link ("https://a.b/c") encodes to 20 base64 characters.
const BASE64_TOKEN_PATTERN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const MIN_EMBEDDED_VALUE_LENGTH = 12;

/**
 * Finds the downloadable link behind an anchor: the href itself, a link carried in a redirect
 * query parameter or path segment, or a base64 (possibly nested) encoding of either.
 */
export function findHrefCandidate(href: string, filter: CandidateFilter): LinkCandidate | null {
    const own = acceptUrl(href, filter);
    if (own) return own;

    for (const value of embeddedValues(href)) {
        const embedded = acceptUrl(value, filter);
        if (embedded) return embedded;
        if (!filter.decodeLinks) continue;
        const decoded = tryDecodeShareUrlBase64(value);
        const candidate = decoded ? acceptUrl(decoded, filter) : null;
        if (candidate) return candidate;
    }
    return null;
}

export function findTextCandidates(text: string, filter: CandidateFilter) {
    return [...text.matchAll(BASE64_TOKEN_PATTERN)].flatMap((match) => {
        const decoded = tryDecodeShareUrlBase64(match[0]);
        const candidate = decoded ? acceptUrl(decoded, filter) : null;
        return candidate ? [{ end: match.index + match[0].length, candidate }] : [];
    });
}

function acceptUrl(url: string, filter: CandidateFilter): LinkCandidate | null {
    const parsed = tryParseDownloadUrl(url.trim());
    if (!parsed || parsed.provider === "extended" || !filter.providers[parsed.provider]) {
        return null;
    }
    if (parsed.provider !== "direct") {
        return { url: url.trim(), provider: parsed.provider };
    }
    // Every http(s) link parses as a direct URL, so links need a file extension to qualify.
    // Encoded links are no exception: they often point at unsupported share pages.
    if (!hasListedExtension(parsed.id, filter.directExtensions)) {
        return null;
    }
    return { url: parsed.id, provider: "direct" };
}

function hasListedExtension(url: string, extensions: readonly string[]) {
    const name = new URL(url).pathname.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    return dot > 0 && extensions.includes(safeDecode(name.slice(dot + 1)).toLowerCase());
}

function embeddedValues(href: string) {
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return [];
    }
    return [
        ...url.searchParams.values(),
        ...url.pathname.split("/").map(safeDecode),
        safeDecode(url.hash.slice(1)),
    ].filter((value) => value.length >= MIN_EMBEDDED_VALUE_LENGTH);
}

function safeDecode(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
