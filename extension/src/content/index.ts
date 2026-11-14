import {
    type CandidateFilter,
    findHrefCandidate,
    findTextCandidates,
} from "@ext/shared/link-candidates";
import { sendExtensionMessage } from "@ext/shared/messages";
import { type ExtensionSettings, loadSettings, subscribeSettings } from "@ext/shared/settings";

import { BUTTON_HOST_ATTRIBUTE, createDownloadButton } from "./button";
import { togglePopover } from "./popover";

const SCAN_DELAY_MS = 250;
const MIN_TEXT_LENGTH = 20;
const SKIPPED_TEXT_CONTAINERS =
    "script, style, noscript, textarea, select, option, title, template";

let settings: ExtensionSettings | null = null;
let processed = new WeakSet<Node>();
let buttonsByAnchor = new WeakMap<HTMLAnchorElement, HTMLElement>();
let buttonsByText = new WeakMap<Text, HTMLElement[]>();
const pendingRoots = new Set<Node>();
let scanTimer: number | undefined;

subscribeSettings((next) => {
    settings = next;
    resetButtons();
});

void loadSettings().then((loaded) => {
    settings = loaded;
    resetButtons();
    observeMutations();
});

function resetButtons() {
    for (const host of document.querySelectorAll(`[${BUTTON_HOST_ATTRIBUTE}]`)) {
        host.remove();
    }
    processed = new WeakSet();
    buttonsByAnchor = new WeakMap();
    buttonsByText = new WeakMap();
    scan(document.body ?? document.documentElement);
}

function observeMutations() {
    new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === "attributes") {
                if (!(mutation.target instanceof HTMLAnchorElement)) continue;
                clearAnchorButton(mutation.target);
                pendingRoots.add(mutation.target);
                continue;
            }
            if (mutation.type === "characterData") {
                if (!(mutation.target instanceof Text)) continue;
                clearTextButtons(mutation.target);
                pendingRoots.add(mutation.target);
                continue;
            }
            for (const node of mutation.removedNodes) {
                if (isButtonHost(node)) continue;
                if (node instanceof Text) {
                    clearTextButtons(node);
                    continue;
                }
                // Anchor buttons are siblings of the anchor, so removing the anchor leaves them behind.
                if (node instanceof HTMLAnchorElement) clearAnchorButton(node);
                if (node instanceof Element) {
                    for (const anchor of node.querySelectorAll("a")) clearAnchorButton(anchor);
                }
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) clearTextButtons(walker.currentNode as Text);
            }
            for (const node of mutation.addedNodes) {
                if (!isButtonHost(node)) pendingRoots.add(node);
            }
        }
        if (pendingRoots.size > 0 && scanTimer === undefined) {
            scanTimer = window.setTimeout(flushPendingRoots, SCAN_DELAY_MS);
        }
    }).observe(document.documentElement, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href"],
    });
}

function flushPendingRoots() {
    scanTimer = undefined;
    const roots = [...pendingRoots];
    pendingRoots.clear();
    for (const root of roots) {
        if (root.isConnected) scan(root);
    }
}

function scan(root: Node) {
    if (!settings?.linkButtons.enabled) return;
    const filter: CandidateFilter = {
        providers: settings.linkButtons.providers,
        directExtensions: settings.linkButtons.directExtensions,
        decodeLinks: settings.linkButtons.decodeLinks,
    };

    if (root instanceof Element) {
        if (root instanceof HTMLAnchorElement) processAnchor(root, filter);
        for (const anchor of root.querySelectorAll("a[href]")) {
            if (anchor instanceof HTMLAnchorElement) processAnchor(anchor, filter);
        }
    }

    if (!settings.linkButtons.decodeText) return;
    if (root instanceof Text) {
        if (acceptsTextNode(root)) processText(root, filter);
        return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
            acceptsTextNode(node as Text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    // Collect first: processText inserts nodes, which would disturb a live walk.
    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
    for (const node of textNodes) processText(node, filter);
}

function processAnchor(anchor: HTMLAnchorElement, filter: CandidateFilter) {
    if (processed.has(anchor)) return;
    processed.add(anchor);
    const candidate = findHrefCandidate(anchor.href, filter);
    if (!candidate) return;
    const host = createDownloadButton((button) => activate(button, candidate.url));
    anchor.insertAdjacentElement("afterend", host);
    buttonsByAnchor.set(anchor, host);
}

function processText(node: Text, filter: CandidateFilter) {
    processed.add(node);
    // Frameworks such as React keep references to their text nodes and update or remove them later,
    // so splitting a node would leave stale text behind. Buttons go after the whole node instead.
    const buttons = findTextCandidates(node.data, filter).map((match) =>
        createDownloadButton((button) => activate(button, match.candidate.url)),
    );
    if (buttons.length === 0) return;
    buttonsByText.set(node, buttons);
    node.after(...buttons);
}

function clearAnchorButton(anchor: HTMLAnchorElement) {
    buttonsByAnchor.get(anchor)?.remove();
    buttonsByAnchor.delete(anchor);
    processed.delete(anchor);
}

function clearTextButtons(node: Text) {
    for (const button of buttonsByText.get(node) ?? []) button.remove();
    buttonsByText.delete(node);
    processed.delete(node);
}

function acceptsTextNode(node: Text) {
    const parent = node.parentElement;
    if (processed.has(node) || node.data.length < MIN_TEXT_LENGTH || !parent) return false;
    if (parent.isContentEditable || parent.closest(SKIPPED_TEXT_CONTAINERS)) return false;
    // The anchor already has a button for its href; a second one for its text would duplicate it.
    const anchor = parent.closest("a");
    return !(anchor instanceof HTMLAnchorElement && buttonsByAnchor.has(anchor));
}

function isButtonHost(node: Node) {
    return node instanceof Element && node.hasAttribute(BUTTON_HOST_ATTRIBUTE);
}

async function activate(button: HTMLElement, url: string) {
    if (settings?.linkButtons.clickAction === "popover") {
        await togglePopover(button, url);
        return null;
    }
    return sendExtensionMessage({ type: "sendLinks", urls: [url], pageUrl: location.href });
}
