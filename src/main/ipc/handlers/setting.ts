import { APP_SETTINGS, type AppSettings, type SettingKey } from "@shared/settings";

import type { KioskDownloader } from "../..";

import { rh } from "../helper";

function getAllSettingKeys() {
    return Object.keys(APP_SETTINGS) as SettingKey[];
}

export function registerSettingHandlers(kd: KioskDownloader) {
    rh("setting:getMany", (keys?: readonly SettingKey[]) =>
        kd.setting.getMany(keys ?? getAllSettingKeys()),
    );
    rh("setting:set", (key: SettingKey, value: AppSettings[SettingKey]) =>
        kd.setting.set(key, value),
    );
}
