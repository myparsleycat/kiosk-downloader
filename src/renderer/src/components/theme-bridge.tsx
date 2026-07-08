import type { SettingTheme } from "@shared/settings";
import * as React from "react";

import { useTheme, type Theme } from "./theme-provider";

const LEGACY_THEME_STORAGE_KEY = "vite-ui-theme";

function isTheme(value: string | null | undefined): value is Theme {
  return value === "dark" || value === "light" || value === "system";
}

export function ThemeBridge() {
  const { setTheme } = useTheme();

  React.useEffect(() => {
    let cancelled = false;

    const syncTheme = async () => {
      const legacyTheme = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
      if (isTheme(legacyTheme)) {
        localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
        await window.api.invoke("setting:set", "general.theme", legacyTheme);
      }

      const values = await window.api.invoke("setting:getMany", ["general.theme"] as const);
      if (cancelled) return;

      setTheme(values["general.theme"] ?? "system");
    };

    void syncTheme();

    const offUpdate = window.api.on("setting:update", ({ key, value }) => {
      if (key === "general.theme") {
        setTheme(value as SettingTheme);
      }
    });

    return () => {
      cancelled = true;
      offUpdate();
    };
  }, [setTheme]);

  return null;
}
