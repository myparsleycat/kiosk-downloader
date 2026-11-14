import type { DownloadProvider } from "./types";

export type { DownloadProvider };
export type WorkuploadShareKind = "file" | "archive";
export type MegaLinkKind = "file" | "folder";
export type MegaLink =
    | {
          type: "public";
          kind: MegaLinkKind;
          handle: string;
          key?: string;
          subFolderId?: string;
          subFileId?: string;
      }
    | { type: "encoded"; kind: MegaLinkKind; version: 1 | 2; payload: string };
export type ParsedDownloadUrl =
    | { provider: Exclude<DownloadProvider, "workupload" | "mega">; id: string }
    | { provider: "workupload"; id: string; kind: WorkuploadShareKind }
    | { provider: "mega"; id: string; link: MegaLink };

export const SHARE_HOST = "kio.ac";
export const SHARE_PATH_PREFIX = "/c/";
export const SHARE_ID_LENGTH = 22;
export const EXTENDED_SHARE_PREFIX = "KDE1.";

export const TRANSFER_HOST = "transfer.it";
export const TRANSFER_PATH_PREFIX = "/t/";
export const TRANSFER_ID_LENGTH = 12;

export const WORKUPLOAD_HOST = "workupload.com";
export const WORKUPLOAD_FILE_PATH_PREFIX = "/file/";
export const WORKUPLOAD_START_PATH_PREFIX = "/start/";
export const WORKUPLOAD_ARCHIVE_PATH_PREFIX = "/archive/";

export const MEGA_HOSTS = ["mega.nz", "mega.co.nz", "mega.io"];
export const MEGA_FILE_KEY_LENGTH = 43;
export const MEGA_FOLDER_KEY_LENGTH = 22;

const SHARE_PROVIDER_HOSTS = [SHARE_HOST, TRANSFER_HOST, WORKUPLOAD_HOST, ...MEGA_HOSTS];

const MEGA_WEB_PATTERN =
    /^(?:https?:\/\/)?(?:www\.)?mega\.(?:nz|co\.nz)\/(?:(file|folder)\/([\w-]+)(?:#([\w-]*))?|#(F?)!([\w-]+)(?:!([\w-]*))?)(?:\/(folder|file)\/([\w-]+))?\/?$/i;
const MEGA_URI_PATTERN =
    /^mega:(?:\/\/\/?)?#?(F?)!([\w-]+)(?:!([\w-]*))?(?:\/(folder|file)\/([\w-]+))?$/i;
const MEGA_ENCODED_PATTERN = /^mega:(?:\/\/\/?)?(f?)enc(2?)\/?\?([\w,=-]+)$/i;

const UUID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
const UUID_DECODE_TABLE = new Map(UUID_ALPHABET.split("").map((char, index) => [char, index]));
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const WORKUPLOAD_ID_PATTERN = /^[A-Za-z0-9]+$/;

export function tryExtractShareId(url: string) {
    let parsed: URL;
    try {
        parsed = new URL(url.trim());
    } catch {
        return null;
    }

    if (parsed.hostname !== SHARE_HOST && parsed.hostname !== `www.${SHARE_HOST}`) {
        return null;
    }
    if (!parsed.pathname.startsWith(SHARE_PATH_PREFIX)) {
        return null;
    }

    const shareId = parsed.pathname.slice(SHARE_PATH_PREFIX.length).split("/")[0];
    if (!shareId || shareId.length !== SHARE_ID_LENGTH) {
        return null;
    }

    return shareId;
}

export function tryExtractTransferId(url: string) {
    let parsed: URL;
    try {
        parsed = new URL(url.trim());
    } catch {
        return null;
    }

    if (parsed.hostname !== TRANSFER_HOST && parsed.hostname !== `www.${TRANSFER_HOST}`) {
        return null;
    }
    if (!parsed.pathname.startsWith(TRANSFER_PATH_PREFIX)) {
        return null;
    }

    const transferId = parsed.pathname.slice(TRANSFER_PATH_PREFIX.length).split("/")[0];
    if (!transferId || transferId.length !== TRANSFER_ID_LENGTH) {
        return null;
    }
    if (!TRANSFER_ID_PATTERN.test(transferId)) {
        return null;
    }

    return transferId;
}

export function shareIdToUuidBytes(shareId: string) {
    if (shareId.length !== SHARE_ID_LENGTH) {
        throw new Error(`Invalid share id length ${shareId.length} (expected ${SHARE_ID_LENGTH}).`);
    }

    const bytes = new Uint8Array(16);
    let bitPos = 0;
    let bytePos = 0;

    for (let sourceIndex = SHARE_ID_LENGTH - 1; sourceIndex >= 0; sourceIndex -= 1) {
        const char = shareId[sourceIndex];
        const value = UUID_DECODE_TABLE.get(char);
        if (value == null) {
            throw new Error(`Invalid character "${char}" in share id.`);
        }

        for (let charBit = 0; charBit < 6 && bytePos < 16; charBit += 1) {
            const bit = (value >> charBit) & 1;
            bytes[bytePos] |= bit << bitPos;
            bitPos += 1;
            if (bitPos === 8) {
                bitPos = 0;
                bytePos += 1;
            }
        }
    }

    return bytes;
}

export function uuidBytesToShareId(bytes: Uint8Array): string {
    if (bytes.length !== 16) {
        throw new Error(`Invalid UUID byte length ${bytes.length} (expected 16).`);
    }

    const out: string[] = new Array(SHARE_ID_LENGTH);
    let bitPos = 0;
    let byteIdx = 0;

    for (let n = SHARE_ID_LENGTH - 1; n >= 0; n -= 1) {
        let value = 0;
        for (let s = 0; s < 6; s += 1) {
            if (byteIdx < 16) {
                const bit = (bytes[byteIdx] >> bitPos) & 1;
                value |= bit << s;
                bitPos += 1;
                if (bitPos === 8) {
                    bitPos = 0;
                    byteIdx += 1;
                }
            }
        }
        out[n] = UUID_ALPHABET[value];
    }

    return out.join("");
}

export function buildShareUrl(shareId: string): string {
    return `https://${SHARE_HOST}${SHARE_PATH_PREFIX}${shareId}`;
}

export function tryParseShareUrl(url: string) {
    const shareId = tryExtractShareId(url);
    if (!shareId) {
        return null;
    }

    try {
        shareIdToUuidBytes(shareId);
    } catch {
        return null;
    }

    return shareId;
}

export function tryParseTransferUrl(url: string) {
    return tryExtractTransferId(url);
}

export function tryParseWorkuploadUrl(
    url: string,
): { id: string; kind: WorkuploadShareKind } | null {
    let parsed: URL;
    try {
        parsed = new URL(url.trim());
    } catch {
        return null;
    }

    if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        parsed.search ||
        parsed.hash ||
        (parsed.hostname !== WORKUPLOAD_HOST && parsed.hostname !== `www.${WORKUPLOAD_HOST}`)
    ) {
        return null;
    }

    const match = /^\/(file|start|archive)\/([^/]+)\/?$/.exec(parsed.pathname);
    if (!match || !WORKUPLOAD_ID_PATTERN.test(match[2])) {
        return null;
    }

    return {
        id: match[2],
        kind: match[1] === "archive" ? "archive" : "file",
    };
}

/**
 * Mega public links (file/folder, sub-folder/sub-file suffixes, legacy `#!`/`#F!`, `mega:` URIs)
 * and MegaDownloader `enc`/`fenc` obfuscated links. A present key must have its full length so a
 * half-typed key is not loaded; a missing key is requested through the password prompt.
 */
export function tryParseMegaUrl(url: string): MegaLink | null {
    const trimmed = url.trim();
    if (/\s/.test(trimmed)) {
        return null;
    }

    const encoded = MEGA_ENCODED_PATTERN.exec(trimmed);
    if (encoded) {
        return {
            type: "encoded",
            kind: encoded[1] ? "folder" : "file",
            version: encoded[2] ? 2 : 1,
            payload: encoded[3],
        };
    }

    const web = MEGA_WEB_PATTERN.exec(trimmed);
    if (web) {
        return web[1]
            ? buildMegaPublicLink(web[1].toLowerCase() === "folder", web[2], web[3], web[7], web[8])
            : buildMegaPublicLink(web[4] !== "", web[5], web[6], web[7], web[8]);
    }

    const uri = MEGA_URI_PATTERN.exec(trimmed);
    if (uri) {
        return buildMegaPublicLink(uri[1] !== "", uri[2], uri[3], uri[4], uri[5]);
    }
    return null;
}

function buildMegaPublicLink(
    isFolder: boolean,
    handle: string,
    key: string | undefined,
    subKind: string | undefined,
    subId: string | undefined,
): MegaLink | null {
    if (key && key.length !== (isFolder ? MEGA_FOLDER_KEY_LENGTH : MEGA_FILE_KEY_LENGTH)) {
        return null;
    }
    if (subId && !isFolder) {
        return null;
    }
    const sub = subKind?.toLowerCase();
    return {
        type: "public",
        kind: isFolder ? "folder" : "file",
        handle,
        ...(key ? { key } : {}),
        ...(subId && sub === "folder" ? { subFolderId: subId } : {}),
        ...(subId && sub === "file" ? { subFileId: subId } : {}),
    };
}

export function tryParseDownloadUrl(url: string): ParsedDownloadUrl | null {
    const shareId = tryParseShareUrl(url);
    if (shareId) {
        return { provider: "kiosk", id: shareId };
    }

    const transferId = tryParseTransferUrl(url);
    if (transferId) {
        return { provider: "transfer", id: transferId };
    }

    const workupload = tryParseWorkuploadUrl(url);
    if (workupload) {
        return { provider: "workupload", ...workupload };
    }

    const mega = tryParseMegaUrl(url);
    if (mega) {
        return {
            provider: "mega",
            id: mega.type === "public" ? mega.handle : mega.payload,
            link: mega,
        };
    }

    const directUrl = tryParseDirectUrl(url);
    if (directUrl) {
        return { provider: "direct", id: directUrl };
    }

    return null;
}

/**
 * Any http(s) URL that is not a recognized share link. Share-provider hosts are
 * rejected so a malformed share link fails instead of downloading the site's HTML.
 */
export function tryParseDirectUrl(url: string) {
    const trimmed = url.trim();
    // The URL parser silently drops tabs/newlines and encodes spaces, which would merge
    // pasted text holding several links into one bogus URL.
    if (/\s/.test(trimmed)) {
        return null;
    }
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }

    if (
        (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
    ) {
        return null;
    }
    const host = parsed.hostname.replace(/\.+$/, "");
    if (
        SHARE_PROVIDER_HOSTS.some(
            (shareHost) => host === shareHost || host.endsWith(`.${shareHost}`),
        )
    ) {
        return null;
    }

    parsed.hash = "";
    return parsed.href;
}

/** Providers whose files lose progress on stop when the server lacks Range support. */
export function usesRangeDependentControl(provider: DownloadProvider | undefined) {
    return provider === "workupload" || provider === "direct";
}

export function buildTransferUrl(transferId: string): string {
    return `https://${TRANSFER_HOST}${TRANSFER_PATH_PREFIX}${transferId}`;
}

export function buildWorkuploadUrl(id: string, kind: WorkuploadShareKind = "file"): string {
    if (!WORKUPLOAD_ID_PATTERN.test(id)) {
        throw new Error(`Invalid Workupload id: ${id}.`);
    }
    const prefix =
        kind === "archive" ? WORKUPLOAD_ARCHIVE_PATH_PREFIX : WORKUPLOAD_FILE_PATH_PREFIX;
    return `https://${WORKUPLOAD_HOST}${prefix}${id}`;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

// Deliberately loose: accepts unpadded and partially-padded base64 as well as
// the URL-safe alphabet (- / _). Partial padding (e.g. a single "=" where "==
// is required) is tolerated because atob handles it and rejecting it would
// needlessly exclude inputs that external base64url encoders produce.
// The URL-safe character normalization (- -> +, _ -> /) is defensive: ASCII
// download URLs never produce - or _ when base64url-encoded, but a user may
// paste output from a tool that uses the URL-safe alphabet on other content.
function decodeBase64Loose(input: string): string | null {
    if (!input || !BASE64_PATTERN.test(input) || input.length % 4 === 1) {
        return null;
    }
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    try {
        return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    } catch {
        return null;
    }
}

export function tryDecodeShareUrlBase64(input: string) {
    let current = input.trim();
    if (!current) {
        return null;
    }

    for (let i = 0; i < 5; i++) {
        const decoded = decodeBase64Loose(current);
        if (decoded === null) {
            return null;
        }

        const next = decoded.trim();
        if (!next || next === current) {
            return null;
        }
        if (tryParseDownloadUrl(next)) {
            return next;
        }
        current = next;
    }

    return null;
}

export function isDownloadShareInput(value: string) {
    const trimmed = value.trim();
    return Boolean(tryParseDownloadUrl(trimmed) || trimmed.startsWith(EXTENDED_SHARE_PREFIX));
}

/**
 * Direct URLs are only loaded on an explicit commit (paste, Enter, bulk add);
 * auto-loading them while typing would probe every partial URL.
 */
export function isAutoCommitShareInput(value: string) {
    const trimmed = value.trim();
    if (trimmed.startsWith(EXTENDED_SHARE_PREFIX)) {
        return true;
    }
    const parsed = tryParseDownloadUrl(trimmed);
    if (parsed?.provider === "mega") {
        return parsed.link.type === "encoded" || parsed.link.key !== undefined;
    }
    return parsed !== null && parsed.provider !== "direct";
}

export function parseBulkShareInputs(text: string) {
    const urls: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();

    for (const token of splitBulkTokens(text)) {
        const resolved = (tryDecodeShareUrlBase64(token) ?? token).trim();
        if (!isDownloadShareInput(resolved)) {
            invalid.push(token);
            continue;
        }
        if (seen.has(resolved)) {
            continue;
        }
        seen.add(resolved);
        urls.push(resolved);
    }

    return { urls, invalid };
}

// Commas separate links, but direct URLs and encoded Mega payloads may contain commas.
// A comma piece glued to such a URL (no whitespace after the comma) that does not look
// like a link of its own is treated as part of that URL; anything link-like stays
// separate so a bad link is still reported.
function splitBulkTokens(text: string) {
    const tokens: string[] = [];
    for (const line of text.split(/[\n\r]+/)) {
        let previousAllowsCommas = false;
        let pendingCommas = "";
        for (const raw of line.split(",")) {
            const token = raw.trim();
            if (previousAllowsCommas && raw === raw.trimStart()) {
                if (!token) {
                    pendingCommas += ",";
                    continue;
                }
                if (!looksLikeLink(token)) {
                    tokens[tokens.length - 1] += `,${pendingCommas}${token}`;
                    pendingCommas = "";
                    continue;
                }
            }
            pendingCommas = "";
            if (!token) {
                previousAllowsCommas = false;
                continue;
            }
            tokens.push(token);
            const parsed = tryParseDownloadUrl(token);
            previousAllowsCommas =
                parsed?.provider === "direct" ||
                (parsed?.provider === "mega" && parsed.link.type === "encoded");
        }
    }
    return tokens;
}

function looksLikeLink(token: string) {
    return (
        /^[a-z][a-z\d+.-]*:/i.test(token) ||
        /^(?:[a-z\d-]+\.)+[a-z]{2,}\//i.test(token) ||
        isDownloadShareInput(tryDecodeShareUrlBase64(token) ?? token)
    );
}
