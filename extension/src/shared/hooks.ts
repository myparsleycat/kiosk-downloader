import * as React from "react";

import { type AppConnection, sendExtensionMessage } from "./messages";
import { type ExtensionSettings, loadSettings, saveSettings, subscribeSettings } from "./settings";

const CONNECTION_POLL_MS = 3000;

export function useExtensionSettings() {
    const [settings, setSettings] = React.useState<ExtensionSettings | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        loadSettings().then(setSettings, (loadError: unknown) => setError(String(loadError)));
        return subscribeSettings(setSettings);
    }, []);

    const update = (updater: (current: ExtensionSettings) => ExtensionSettings) => {
        if (!settings) return;
        const next = updater(settings);
        setSettings(next);
        saveSettings(next).then(
            () => setError(null),
            (saveError: unknown) => setError(`설정을 저장하지 못했습니다: ${String(saveError)}`),
        );
    };

    return { settings, update, error };
}

export function useAppConnection() {
    const [connection, setConnection] = React.useState<AppConnection | null>(null);
    const [busy, setBusy] = React.useState(false);

    const refresh = React.useCallback(() => {
        sendExtensionMessage({ type: "getConnection" }).then(setConnection, () =>
            setConnection({ state: "offline" }),
        );
    }, []);

    React.useEffect(() => {
        refresh();
        const timer = window.setInterval(refresh, CONNECTION_POLL_MS);
        return () => window.clearInterval(timer);
    }, [refresh]);

    const run = async (type: "pair" | "launchApp") => {
        setBusy(true);
        try {
            setConnection(await sendExtensionMessage({ type }));
        } finally {
            setBusy(false);
        }
    };

    return { connection, busy, pair: () => run("pair"), launch: () => run("launchApp") };
}

export function applySystemTheme() {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", query.matches);
    apply();
    query.addEventListener("change", apply);
}
