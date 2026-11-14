import type { ExtensionMessage, SendResult } from "@ext/shared/messages";
import { createPopoverSession } from "@ext/shared/popover";
import type { BrowserExtensionRequestItem } from "@shared/browser-extension";
import { tryParseDownloadUrl } from "@shared/share-url";

import { getConnection, launchApp, requestPairing, sendItemsLaunchingApp } from "./app-client";
import { registerDownloadInterception } from "./intercept";
import { buildDirectRequestHeaders } from "./request-headers";

registerDownloadInterception();

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse, (error: unknown) => {
        console.error("[kioex] message handling failed", { type: message.type, error });
        sendResponse({
            ok: false,
            reason: "failed",
            message: error instanceof Error ? error.message : String(error),
        } satisfies SendResult);
    });
    return true;
});

async function handleMessage(message: ExtensionMessage, sender: chrome.runtime.MessageSender) {
    switch (message.type) {
        case "sendLinks":
            return sendItemsLaunchingApp(
                await Promise.all(message.urls.map((url) => buildLinkItem(url, message.pageUrl))),
                sender.tab?.id,
            );
        case "openPopover": {
            const item = await buildLinkItem(message.url, message.pageUrl);
            return createPopoverSession({
                url: item.url,
                pageUrl: message.pageUrl,
                headers: item.headers,
            });
        }
        case "getConnection":
            return getConnection();
        case "pair":
            return requestPairing();
        case "launchApp":
            return launchApp(undefined);
    }
}

async function buildLinkItem(url: string, pageUrl: string): Promise<BrowserExtensionRequestItem> {
    // Only direct downloads replay browser headers; share providers use their own APIs.
    const headers =
        tryParseDownloadUrl(url)?.provider === "direct"
            ? await buildDirectRequestHeaders(url, pageUrl)
            : undefined;
    return { url, headers, source: "link" };
}
