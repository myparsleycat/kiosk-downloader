import z from "zod";

import type { PrepareDownloadResult } from "./types";

import { BROWSER_EXTENSION_ID_PATTERN } from "./settings";
import { isDownloadShareInput, tryDecodeShareUrlBase64 } from "./share-url";

export const BROWSER_EXTENSION_PORTS = [41730, 41731, 41732, 41733, 41734] as const;
export const BROWSER_EXTENSION_PROTOCOL_VERSION = 3;
export const BROWSER_EXTENSION_PAIRING_PROTOCOL = 3;
/** First protocol version that serves the prepare/start/discard routes used by the link popover. */
export const BROWSER_EXTENSION_POPOVER_PROTOCOL = 2;
export const BROWSER_EXTENSION_APP_NAME = "kiosk-downloader";
export const BROWSER_EXTENSION_API_PREFIX = "/kioex/v1";
export const BROWSER_EXTENSION_MAX_ITEMS = 100;
export const DEEP_LINK_SCHEME = "kioskdl";
export const DEEP_LINK_OPEN_URL = `${DEEP_LINK_SCHEME}://open`;

const EXTENSION_ORIGIN_PREFIX = "chrome-extension://";

const shareUrlSchema = z
    .string()
    .trim()
    .min(1)
    .max(8192)
    .refine((url) => isDownloadShareInput(tryDecodeShareUrlBase64(url) ?? url));

const requestHeadersSchema = z
    .object({
        referer: z.string().max(8192).optional(),
        cookie: z.string().max(8192).optional(),
        userAgent: z.string().max(1024).optional(),
    })
    .optional();

const draftIdSchema = z.string().min(1).max(128);

export const browserExtensionRequestItemSchema = z.object({
    url: shareUrlSchema,
    headers: requestHeadersSchema,
    source: z.enum(["link", "intercept"]),
});

export const browserExtensionRequestSchema = z.object({
    items: z.array(browserExtensionRequestItemSchema).min(1).max(BROWSER_EXTENSION_MAX_ITEMS),
});

export const browserExtensionPrepareSchema = z.object({
    url: shareUrlSchema,
    headers: requestHeadersSchema,
    password: z.string().max(1024).optional(),
});

const zipPasswordSchema = z.string().min(1).max(1024);

export const browserExtensionStartSchema = z.object({
    draftId: draftIdSchema,
    selectedPaths: z.array(z.string().max(8192)).min(1),
    zipPasswords: z.record(z.string().max(256), zipPasswordSchema).optional(),
});

export const browserExtensionZipEntriesSchema = z.object({
    draftId: draftIdSchema,
    fileId: z.string().min(1).max(256),
    zipPassword: zipPasswordSchema.optional(),
});

export const browserExtensionDiscardSchema = z.object({ draftId: draftIdSchema });
export const browserExtensionPairSchema = z.object({ retryDenied: z.boolean().optional() });

export type BrowserExtensionRequestItem = z.infer<typeof browserExtensionRequestItemSchema>;
export type BrowserExtensionRequest = z.infer<typeof browserExtensionRequestSchema>;
export type BrowserExtensionPrepareRequest = z.infer<typeof browserExtensionPrepareSchema>;
export type BrowserExtensionStartRequest = z.infer<typeof browserExtensionStartSchema>;
export type BrowserExtensionZipEntriesRequest = z.infer<typeof browserExtensionZipEntriesSchema>;

export type BrowserExtensionPrepareResponse =
    | Exclude<PrepareDownloadResult, { status: "ready" }>
    | (Extract<PrepareDownloadResult, { status: "ready" }> & { savePath: string });

export type BrowserExtensionStartResponse = { name: string };

export type BrowserExtensionPingResponse = {
    app: typeof BROWSER_EXTENSION_APP_NAME;
    version: string;
    protocol: number;
    paired: boolean;
    pairingDenied: boolean;
};

export type BrowserExtensionErrorCode =
    | "forbidden"
    | "pairingDenied"
    | "pairingRequired"
    | "invalidRequest"
    | "unsupportedMediaType"
    | "payloadTooLarge"
    | "notFound"
    | "operationFailed";

export type BrowserExtensionErrorResponse = { error: BrowserExtensionErrorCode; message?: string };

export type BrowserExtensionServerStatus = {
    enabled: boolean;
    port: number | null;
    error: string | null;
};

export function parseExtensionOrigin(origin: string | undefined) {
    if (!origin?.startsWith(EXTENSION_ORIGIN_PREFIX)) {
        return null;
    }
    const id = origin.slice(EXTENSION_ORIGIN_PREFIX.length);
    return BROWSER_EXTENSION_ID_PATTERN.test(id) ? id : null;
}
