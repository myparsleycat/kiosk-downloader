import { sendExtensionMessage } from "@ext/shared/messages";
import {
    POPOVER_MESSAGE_TYPE,
    POPOVER_PAGE_PATH,
    POPOVER_WIDTH,
    type PopoverFrameMessage,
} from "@ext/shared/popover";

import { BUTTON_HOST_ATTRIBUTE } from "./button";

const INITIAL_HEIGHT = 140;
const GAP = 6;
const VIEWPORT_MARGIN = 8;

let active: { anchor: HTMLElement; close: () => void } | null = null;

/** Opens the popover for a link button, or closes it when that button's popover is already open. */
export async function togglePopover(anchor: HTMLElement, url: string) {
    if (active?.anchor === anchor) {
        active.close();
        return;
    }
    active?.close();
    const token = await sendExtensionMessage({ type: "openPopover", url, pageUrl: location.href });
    active?.close();
    if (!anchor.isConnected) return;
    active = { anchor, close: mountPopover(anchor, token) };
}

function mountPopover(anchor: HTMLElement, token: string) {
    // Shares the button attribute so the link scanner skips it and settings changes remove it.
    const host = document.createElement("span");
    host.setAttribute(BUTTON_HOST_ATTRIBUTE, "");
    const root = host.attachShadow({ mode: "closed" });
    const frame = document.createElement("iframe");
    frame.src = `${chrome.runtime.getURL(POPOVER_PAGE_PATH)}#${token}`;
    frame.title = "Kiosk Downloader";
    frame.style.cssText = `display:block;width:100%;height:${INITIAL_HEIGHT}px;border:0;border-radius:10px;box-shadow:0 8px 24px rgb(0 0 0 / 0.2);color-scheme:normal;`;
    root.append(frame);

    // Inline !important beats page rules, including the page's own !important ones.
    const setStyle = (property: string, value: string) =>
        host.style.setProperty(property, value, "important");
    for (const [property, value] of Object.entries({
        all: "initial",
        position: "absolute",
        "z-index": "2147483647",
        display: "block",
        width: `${POPOVER_WIDTH}px`,
    })) {
        setStyle(property, value);
    }

    let height = INITIAL_HEIGHT;
    const place = () => {
        const rect = anchor.getBoundingClientRect();
        const below = rect.bottom + GAP;
        const top =
            below + height > window.innerHeight && rect.top - GAP - height >= 0
                ? rect.top - GAP - height
                : below;
        const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
        const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft));
        setStyle("top", `${top + window.scrollY}px`);
        setStyle("left", `${left + window.scrollX}px`);
    };

    const onMessage = (event: MessageEvent<PopoverFrameMessage>) => {
        if (event.source !== frame.contentWindow || event.data?.type !== POPOVER_MESSAGE_TYPE) {
            return;
        }
        if (event.data.action === "close") {
            close();
            return;
        }
        height = event.data.height;
        frame.style.height = `${height}px`;
        place();
    };
    const onPointerDown = (event: MouseEvent) => {
        const path = event.composedPath();
        if (!path.includes(host) && !path.includes(anchor)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") close();
    };

    function close() {
        window.removeEventListener("message", onMessage);
        document.removeEventListener("mousedown", onPointerDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("resize", place);
        host.remove();
        if (active?.close === close) active = null;
    }

    window.addEventListener("message", onMessage);
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", place);
    document.documentElement.append(host);
    place();
    frame.addEventListener("load", () => frame.focus(), { once: true });
    return close;
}
