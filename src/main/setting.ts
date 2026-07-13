import {
    APP_SETTINGS,
    type AppSettings,
    BANDWIDTH_LIMIT_MIBPS_DEFAULT,
    BANDWIDTH_LIMIT_MIBPS_MAX,
    BANDWIDTH_LIMIT_MIBPS_MIN,
    CHUNK_RETRY_DEFAULT,
    CHUNK_RETRY_MAX,
    CHUNK_RETRY_MIN,
    COLLECTION_PASSWORD_LIST_MAX,
    UPLOAD_CHUNK_RETRY_DEFAULT,
    UPLOAD_CHUNK_RETRY_MAX,
    UPLOAD_CHUNK_RETRY_MIN,
    SETTING_LOG_LEVELS,
    SEGMENT_POOL_SIZE_DEFAULT,
    SEGMENT_POOL_SIZE_MAX,
    SEGMENT_POOL_SIZE_MIN,
    SETTING_THEMES,
    type SettingDefinition,
    type SettingKey,
    STARTUP_RESUME_MODES,
    STREAM_WRITE_BATCH_BYTES_DEFAULT,
    STREAM_WRITE_BATCH_BYTES_OPTIONS,
    INFLATE_BUFFER_BYTES_DEFAULT,
    INFLATE_BUFFER_BYTES_OPTIONS,
} from "@shared/settings";
import AutoLaunch from "auto-launch";
import { app, nativeTheme } from "electron";

import { KioskDownloader } from ".";
import { isPortable } from "./lib/isPortable";

interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

type MainSettingSpec<K extends SettingKey> = {
    definition: SettingDefinition<K>;
    getDefault: () => AppSettings[K] | Promise<AppSettings[K]>;
    fromStored: (value: string | null | undefined) => AppSettings[K];
    toStored?: (value: AppSettings[K]) => string;
    normalize?: (value: AppSettings[K]) => AppSettings[K];
    afterSet?: (value: AppSettings[K]) => Promise<void> | void;
};

type MainSettingSpecMap = {
    [K in SettingKey]: MainSettingSpec<K>;
};

function parseBooleanSetting(value: string | null | undefined, fallback: boolean) {
    if (value == null) {
        return fallback;
    }

    return value === "true";
}

function clampInteger(value: number, min: number, max: number, fallback: number) {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(value)));
}

function fromOptions<T>(value: unknown, options: readonly T[], fallback: T): T {
    return options.find((option) => option === value) ?? fallback;
}

function parseBoundedIntegerSetting(
    value: string | null | undefined,
    fallback: number,
    min: number,
    max: number,
) {
    return clampInteger(Number.parseInt(value ?? "", 10), min, max, fallback);
}

function parseStreamWriteBatchBytes(value: string | null | undefined) {
    return fromOptions(
        Number.parseInt(value ?? "", 10),
        STREAM_WRITE_BATCH_BYTES_OPTIONS,
        STREAM_WRITE_BATCH_BYTES_DEFAULT,
    );
}

function parseInflateBufferBytes(value: string | null | undefined) {
    return fromOptions(
        Number.parseInt(value ?? "", 10),
        INFLATE_BUFFER_BYTES_OPTIONS,
        INFLATE_BUFFER_BYTES_DEFAULT,
    );
}

function normalizeDownloadPath(value: string) {
    return value.trim();
}

function parseCollectionPasswordList(value: string | null | undefined): string[] {
    if (value == null || value === "") {
        return [];
    }

    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return normalizeCollectionPasswordList(parsed.filter((item) => typeof item === "string"));
    } catch {
        return [];
    }
}

function normalizeCollectionPasswordList(value: string[]) {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const item of value) {
        const trimmed = item.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        result.push(trimmed);
        if (result.length >= COLLECTION_PASSWORD_LIST_MAX) {
            break;
        }
    }

    return result;
}

export class Setting {
    private kd: KioskDownloader;
    private settingSpecs: MainSettingSpecMap | null = null;

    constructor(kd: KioskDownloader) {
        this.kd = kd;
    }

    private getSettingSpecMap(): MainSettingSpecMap {
        if (this.settingSpecs) {
            return this.settingSpecs;
        }

        this.settingSpecs = {
            "general.runOnStartup": {
                definition: APP_SETTINGS["general.runOnStartup"],
                getDefault: () => false,
                fromStored: (value) => parseBooleanSetting(value, false),
                toStored: (value) => String(value),
                afterSet: async (enabled) => {
                    if (!app.isPackaged || isPortable()) {
                        return;
                    }

                    const autoLaunch = new AutoLaunch({
                        name: "Kiosk Downloader",
                        path: app.getPath("exe"),
                        isHidden: true,
                    });

                    if (enabled) {
                        await autoLaunch.enable();
                        return;
                    }

                    await autoLaunch.disable();
                },
            },
            "general.runInBackground": {
                definition: APP_SETTINGS["general.runInBackground"],
                getDefault: () => true,
                fromStored: (value) => parseBooleanSetting(value, true),
                toStored: (value) => String(value),
            },
            "general.lastDownloadPath": {
                definition: APP_SETTINGS["general.lastDownloadPath"],
                getDefault: () => app.getPath("downloads"),
                fromStored: (value) => value?.trim() || app.getPath("downloads"),
                toStored: (value) => value,
                normalize: normalizeDownloadPath,
            },
            "general.createCollectionSubfolder": {
                definition: APP_SETTINGS["general.createCollectionSubfolder"],
                getDefault: () => true,
                fromStored: (value) => parseBooleanSetting(value, true),
                toStored: (value) => String(value),
            },
            "general.asciiFilenames": {
                definition: APP_SETTINGS["general.asciiFilenames"],
                getDefault: () => false,
                fromStored: (value) => parseBooleanSetting(value, false),
                toStored: (value) => String(value),
            },
            "general.logLevel": {
                definition: APP_SETTINGS["general.logLevel"],
                getDefault: () => "error" as const,
                fromStored: (value) => fromOptions(value, SETTING_LOG_LEVELS, "error"),
                toStored: (value) => value,
                normalize: (value) => fromOptions(value, SETTING_LOG_LEVELS, "error"),
                afterSet: (level) => {
                    this.kd.logger.setLevel(level);
                },
            },
            "general.theme": {
                definition: APP_SETTINGS["general.theme"],
                getDefault: () => "system" as const,
                fromStored: (value) => fromOptions(value, SETTING_THEMES, "system"),
                toStored: (value) => value,
                normalize: (value) => fromOptions(value, SETTING_THEMES, "system"),
                afterSet: (value) => {
                    nativeTheme.themeSource = value;
                },
            },
            "general.powerSaveBlockInTransfer": {
                definition: APP_SETTINGS["general.powerSaveBlockInTransfer"],
                getDefault: () => true,
                fromStored: (value) => parseBooleanSetting(value, true),
                toStored: (value) => String(value),
                afterSet: async () => {
                    await this.kd.service.transfer.refreshPowerSaveBlock();
                },
            },
            "general.shutdownAfterTransfer": {
                definition: APP_SETTINGS["general.shutdownAfterTransfer"],
                getDefault: () => false,
                fromStored: (value) => parseBooleanSetting(value, false),
                toStored: (value) => String(value),
            },
            "general.autoTryCollectionPasswords": {
                definition: APP_SETTINGS["general.autoTryCollectionPasswords"],
                getDefault: () => false,
                fromStored: (value) => parseBooleanSetting(value, false),
                toStored: (value) => String(value),
            },
            "general.collectionPasswordList": {
                definition: APP_SETTINGS["general.collectionPasswordList"],
                getDefault: () => [],
                fromStored: parseCollectionPasswordList,
                toStored: (value) => JSON.stringify(value),
                normalize: normalizeCollectionPasswordList,
            },
            "transfer.segmentPoolSize": {
                definition: APP_SETTINGS["transfer.segmentPoolSize"],
                getDefault: () => SEGMENT_POOL_SIZE_DEFAULT,
                fromStored: (value) =>
                    parseBoundedIntegerSetting(
                        value,
                        SEGMENT_POOL_SIZE_DEFAULT,
                        SEGMENT_POOL_SIZE_MIN,
                        SEGMENT_POOL_SIZE_MAX,
                    ),
                toStored: (value) => String(value),
                normalize: (value) =>
                    clampInteger(
                        value,
                        SEGMENT_POOL_SIZE_MIN,
                        SEGMENT_POOL_SIZE_MAX,
                        SEGMENT_POOL_SIZE_DEFAULT,
                    ),
            },
            "transfer.maxChunkRetries": {
                definition: APP_SETTINGS["transfer.maxChunkRetries"],
                getDefault: () => CHUNK_RETRY_DEFAULT,
                fromStored: (value) =>
                    parseBoundedIntegerSetting(
                        value,
                        CHUNK_RETRY_DEFAULT,
                        CHUNK_RETRY_MIN,
                        CHUNK_RETRY_MAX,
                    ),
                toStored: (value) => String(value),
                normalize: (value) =>
                    clampInteger(value, CHUNK_RETRY_MIN, CHUNK_RETRY_MAX, CHUNK_RETRY_DEFAULT),
            },
            "transfer.uploadMaxChunkRetries": {
                definition: APP_SETTINGS["transfer.uploadMaxChunkRetries"],
                getDefault: () => UPLOAD_CHUNK_RETRY_DEFAULT,
                fromStored: (value) =>
                    parseBoundedIntegerSetting(
                        value,
                        UPLOAD_CHUNK_RETRY_DEFAULT,
                        UPLOAD_CHUNK_RETRY_MIN,
                        UPLOAD_CHUNK_RETRY_MAX,
                    ),
                toStored: (value) => String(value),
                normalize: (value) =>
                    clampInteger(
                        value,
                        UPLOAD_CHUNK_RETRY_MIN,
                        UPLOAD_CHUNK_RETRY_MAX,
                        UPLOAD_CHUNK_RETRY_DEFAULT,
                    ),
            },
            "transfer.streamWriteBatchBytes": {
                definition: APP_SETTINGS["transfer.streamWriteBatchBytes"],
                getDefault: () => STREAM_WRITE_BATCH_BYTES_DEFAULT,
                fromStored: parseStreamWriteBatchBytes,
                toStored: (value) => String(value),
                normalize: (value) =>
                    fromOptions(
                        value,
                        STREAM_WRITE_BATCH_BYTES_OPTIONS,
                        STREAM_WRITE_BATCH_BYTES_DEFAULT,
                    ),
            },
            "transfer.inflateBufferBytes": {
                definition: APP_SETTINGS["transfer.inflateBufferBytes"],
                getDefault: () => INFLATE_BUFFER_BYTES_DEFAULT,
                fromStored: parseInflateBufferBytes,
                toStored: (value) => String(value),
                normalize: (value) =>
                    fromOptions(value, INFLATE_BUFFER_BYTES_OPTIONS, INFLATE_BUFFER_BYTES_DEFAULT),
            },
            "transfer.startupResumeMode": {
                definition: APP_SETTINGS["transfer.startupResumeMode"],
                getDefault: () => "auto" as const,
                fromStored: (value) => fromOptions(value, STARTUP_RESUME_MODES, "auto"),
                toStored: (value) => value,
                normalize: (value) => fromOptions(value, STARTUP_RESUME_MODES, "auto"),
            },
            "transfer.uploadStartupResumeMode": {
                definition: APP_SETTINGS["transfer.uploadStartupResumeMode"],
                getDefault: () => "auto" as const,
                fromStored: (value) => fromOptions(value, STARTUP_RESUME_MODES, "auto"),
                toStored: (value) => value,
                normalize: (value) => fromOptions(value, STARTUP_RESUME_MODES, "auto"),
            },
            "transfer.downloadBandwidthLimitMibps": {
                definition: APP_SETTINGS["transfer.downloadBandwidthLimitMibps"],
                getDefault: () => BANDWIDTH_LIMIT_MIBPS_DEFAULT,
                fromStored: (value) =>
                    parseBoundedIntegerSetting(
                        value,
                        BANDWIDTH_LIMIT_MIBPS_DEFAULT,
                        BANDWIDTH_LIMIT_MIBPS_MIN,
                        BANDWIDTH_LIMIT_MIBPS_MAX,
                    ),
                toStored: (value) => String(value),
                normalize: (value) =>
                    clampInteger(
                        value,
                        BANDWIDTH_LIMIT_MIBPS_MIN,
                        BANDWIDTH_LIMIT_MIBPS_MAX,
                        BANDWIDTH_LIMIT_MIBPS_DEFAULT,
                    ),
                afterSet: (value) => {
                    this.kd.service.transfer.setDownloadBandwidthLimitMibps(value);
                },
            },
            "transfer.uploadBandwidthLimitMibps": {
                definition: APP_SETTINGS["transfer.uploadBandwidthLimitMibps"],
                getDefault: () => BANDWIDTH_LIMIT_MIBPS_DEFAULT,
                fromStored: (value) =>
                    parseBoundedIntegerSetting(
                        value,
                        BANDWIDTH_LIMIT_MIBPS_DEFAULT,
                        BANDWIDTH_LIMIT_MIBPS_MIN,
                        BANDWIDTH_LIMIT_MIBPS_MAX,
                    ),
                toStored: (value) => String(value),
                normalize: (value) =>
                    clampInteger(
                        value,
                        BANDWIDTH_LIMIT_MIBPS_MIN,
                        BANDWIDTH_LIMIT_MIBPS_MAX,
                        BANDWIDTH_LIMIT_MIBPS_DEFAULT,
                    ),
                afterSet: (value) => {
                    this.kd.service.transfer.setUploadBandwidthLimitMibps(value);
                },
            },
        };

        return this.settingSpecs;
    }

    private getSettingSpec<K extends SettingKey>(key: K): MainSettingSpec<K> {
        return this.getSettingSpecMap()[key] as MainSettingSpec<K>;
    }

    private async findStoredSetting(storageKey: string) {
        return await this.kd.lib.db.settings.get(storageKey);
    }

    private async upsertStoredSetting(storageKey: string, value: string | null) {
        await this.kd.lib.db.settings.upsert(storageKey, value);
    }

    public async get<K extends SettingKey>(key: K): Promise<AppSettings[K]> {
        const spec = this.getSettingSpec(key);
        const current = await this.findStoredSetting(spec.definition.storageKey);

        if ((!current || current.value == null) && key === "transfer.segmentPoolSize") {
            for (const legacyStorageKey of [
                "transfer.maxConcurrentSegments",
                "transfer.maxSegmentsPerFile",
            ]) {
                const legacy = await this.findStoredSetting(legacyStorageKey);
                if (legacy?.value == null) {
                    continue;
                }

                const resolved = spec.normalize
                    ? spec.normalize(spec.fromStored(legacy.value))
                    : spec.fromStored(legacy.value);
                const storedValue = spec.toStored ? spec.toStored(resolved) : String(resolved);
                await this.upsertStoredSetting(spec.definition.storageKey, storedValue);
                return resolved;
            }
        }

        if (!current || current.value == null) {
            const fallback = spec.normalize
                ? spec.normalize(await spec.getDefault())
                : await spec.getDefault();
            const storedValue = spec.toStored ? spec.toStored(fallback) : String(fallback);
            await this.upsertStoredSetting(spec.definition.storageKey, storedValue);
            return fallback;
        }

        const resolved = spec.normalize
            ? spec.normalize(spec.fromStored(current.value))
            : spec.fromStored(current.value);
        const storedValue = spec.toStored ? spec.toStored(resolved) : String(resolved);

        if (storedValue !== current.value) {
            await this.upsertStoredSetting(spec.definition.storageKey, storedValue);
        }

        if (key === "general.runOnStartup" && isPortable()) {
            return false as AppSettings[K];
        }

        return resolved;
    }

    public async getMany<K extends readonly SettingKey[]>(
        keys: K,
    ): Promise<{ [P in K[number]]: AppSettings[P] }> {
        const entries = await Promise.all(
            keys.map(async (key) => [key, await this.get(key)] as const),
        );

        return Object.fromEntries(entries) as { [P in K[number]]: AppSettings[P] };
    }

    public async set<K extends SettingKey>(key: K, value: AppSettings[K]): Promise<AppSettings[K]> {
        if (key === "general.runOnStartup" && isPortable()) {
            return value;
        }

        const spec = this.getSettingSpec(key);
        const normalized = spec.normalize ? spec.normalize(value) : value;
        const storedValue = spec.toStored ? spec.toStored(normalized) : String(normalized);

        await this.upsertStoredSetting(spec.definition.storageKey, storedValue);
        await spec.afterSet?.(normalized);

        this.kd.ipc.sendToMainWindow("setting:update", { key, value: normalized });
        return normalized;
    }

    private async getStoredBounds(key: string) {
        const qr = await this.kd.lib.db.settings.get(key);

        if (!qr) return null;

        const bounds = JSON.parse(qr.value as string) as Bounds;

        return bounds;
    }

    private async setStoredBounds(key: string, bounds: Bounds) {
        const value = JSON.stringify(bounds);
        await this.kd.lib.db.settings.upsert(key, value);
    }

    public async getBounds() {
        return this.getStoredBounds("bounds");
    }

    public async setBounds(bounds: Bounds) {
        await this.setStoredBounds("bounds", bounds);
    }

    public async getSettingBounds() {
        return this.getStoredBounds("settingBounds");
    }

    public async setSettingBounds(bounds: Bounds) {
        await this.setStoredBounds("settingBounds", bounds);
    }
}

export default Setting;
