import type { BrowserExtensionRequestItem } from "@shared/browser-extension";

export const POPOVER_PAGE_PATH = "src/popover/index.html";
export const POPOVER_WIDTH = 380;
export const POPOVER_MESSAGE_TYPE = "kioex:popover";

export type PopoverFrameMessage = { type: typeof POPOVER_MESSAGE_TYPE } & (
    | { action: "close" }
    | { action: "resize"; height: number }
);

export type PopoverSession = {
    url: string;
    pageUrl: string;
    headers: BrowserExtensionRequestItem["headers"];
};

// Popover pages are web-accessible, so a page could frame one itself. The link reaches the popover
// only through a one-time token that the content script obtains from the background, never through
// the frame URL, so a page cannot make the popover offer a link of its choosing.
const sessionKey = (token: string) => `popover:${token}`;

export async function createPopoverSession(session: PopoverSession) {
    const token = crypto.randomUUID();
    await chrome.storage.session.set({ [sessionKey(token)]: session });
    return token;
}

export async function takePopoverSession(token: string) {
    const key = sessionKey(token);
    const stored = await chrome.storage.session.get(key);
    await chrome.storage.session.remove(key);
    return stored[key] as PopoverSession | undefined;
}
