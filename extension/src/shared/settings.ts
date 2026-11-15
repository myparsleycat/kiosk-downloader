import { escapeRegExp } from "es-toolkit";
import z from "zod";

export const LINK_PROVIDERS = ["kiosk", "transfer", "workupload", "mega", "direct"] as const;
export type LinkProvider = (typeof LINK_PROVIDERS)[number];

export const LINK_PROVIDER_LABELS: Record<LinkProvider, string> = {
    kiosk: "Kiosk (kio.ac)",
    transfer: "transfer.it",
    workupload: "Workupload",
    mega: "Mega",
    direct: "직접 링크",
};

export const LINK_CLICK_ACTIONS = ["send", "popover"] as const;
export type LinkClickAction = (typeof LINK_CLICK_ACTIONS)[number];

export const LINK_CLICK_ACTION_LABELS: Record<LinkClickAction, string> = {
    send: "앱으로 보내기",
    popover: "파일 선택 후 바로 다운로드",
};

const DEFAULT_DIRECT_EXTENSIONS = [
    "zip",
    "7z",
    "rar",
    "tar",
    "gz",
    "bz2",
    "xz",
    "zst",
    "iso",
    "exe",
    "msi",
    "dmg",
    "apk",
    "mp4",
    "mkv",
    "avi",
    "mov",
    "webm",
    "mp3",
    "flac",
    "wav",
];

const SETTINGS_STORAGE_KEY = "settings";

// prefault() runs the empty object through the schema, so stored settings from an older version
// gain defaults for fields added later instead of failing validation.
const extensionSettingsSchema = z.object({
    linkButtons: z
        .object({
            enabled: z.boolean().default(true),
            clickAction: z.enum(LINK_CLICK_ACTIONS).default("send"),
            providers: z
                .object({
                    kiosk: z.boolean().default(true),
                    transfer: z.boolean().default(true),
                    workupload: z.boolean().default(true),
                    mega: z.boolean().default(true),
                    direct: z.boolean().default(true),
                })
                .prefault({}),
            directExtensions: z.array(z.string()).default(DEFAULT_DIRECT_EXTENSIONS),
            decodeLinks: z.boolean().default(true),
            decodeText: z.boolean().default(true),
        })
        .prefault({}),
    intercept: z
        .object({
            enabled: z.boolean().default(false),
            extensions: z.array(z.string()).default([]),
            minSizeMiB: z.number().min(0).default(0),
            excludedHosts: z.array(z.string()).default([]),
            launchApp: z.boolean().default(false),
        })
        .prefault({}),
});

export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;

export const DEFAULT_SETTINGS = extensionSettingsSchema.parse({});

export async function loadSettings() {
    const stored = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
    const parsed = extensionSettingsSchema.safeParse(stored[SETTINGS_STORAGE_KEY] ?? {});
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: ExtensionSettings) {
    await chrome.storage.sync.set({ [SETTINGS_STORAGE_KEY]: settings });
}

export function subscribeSettings(listener: (settings: ExtensionSettings) => void) {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area !== "sync" || !(SETTINGS_STORAGE_KEY in changes)) return;
        const parsed = extensionSettingsSchema.safeParse(
            changes[SETTINGS_STORAGE_KEY].newValue ?? {},
        );
        listener(parsed.success ? parsed.data : DEFAULT_SETTINGS);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
}

export function parseListInput(value: string) {
    return [
        ...new Set(
            value
                .split(/[\s,]+/)
                .map((entry) => entry.trim().replace(/^\./, "").toLowerCase())
                .filter(Boolean),
        ),
    ];
}

export function parseHostListInput(value: string) {
    return [
        ...new Set(parseListInput(value).flatMap((entry) => normalizeHostPattern(entry) ?? [])),
    ];
}

// URL parsing strips the scheme, credentials, port and path, lowercases, and converts IDNs to
// punycode so patterns compare against the same form as download hostnames. "*" passes through.
function normalizeHostPattern(entry: string) {
    try {
        const url = new URL(/^[a-z][a-z\d+.-]*:\/\//.test(entry) ? entry : `http://${entry}`);
        return url.hostname.replace(/^\.+|\.+$/g, "") || null;
    } catch {
        return null;
    }
}

export function matchesHost(hostname: string, patterns: readonly string[]) {
    const host = hostname.toLowerCase();
    return patterns.some((pattern) => hostPatternRegExp(pattern).test(host));
}

// Every pattern also matches its subdomains. A leading "*." is dropped so "*.example.com" still
// matches example.com itself, matching the no-wildcard form.
function hostPatternRegExp(pattern: string) {
    const body = pattern.replace(/^\*\./, "").split("*").map(escapeRegExp).join(".*");
    return new RegExp(`^(?:.*\\.)?${body}$`);
}
