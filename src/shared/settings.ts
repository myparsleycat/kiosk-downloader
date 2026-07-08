export const STARTUP_RESUME_MODES = ["auto", "manual"] as const;
export type StartupResumeMode = (typeof STARTUP_RESUME_MODES)[number];

export const SETTING_LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type SettingLogLevel = (typeof SETTING_LOG_LEVELS)[number];

export const SETTING_THEMES = ["system", "light", "dark"] as const;
export type SettingTheme = (typeof SETTING_THEMES)[number];

export interface AppSettings {
    "general.runOnStartup": boolean;
    "general.runInBackground": boolean;
    "general.lastDownloadPath": string;
    "general.createCollectionSubfolder": boolean;
    "general.logLevel": SettingLogLevel;
    "general.theme": SettingTheme;
    "general.powerSaveBlockInTransfer": boolean;
    "transfer.segmentPoolSize": number;
    "transfer.maxChunkRetries": number;
    "transfer.streamWriteBatchBytes": number;
    "transfer.startupResumeMode": StartupResumeMode;
}

export const CHUNK_RETRY_MIN = 3;
export const CHUNK_RETRY_MAX = 10;
export const CHUNK_RETRY_DEFAULT = 5;

export const SEGMENT_POOL_SIZE_MIN = 2;
export const SEGMENT_POOL_SIZE_MAX = 64;
export const SEGMENT_POOL_SIZE_DEFAULT = 8;

export const STREAM_WRITE_BATCH_BYTES_OPTIONS = [
    256 * 1024,
    512 * 1024,
    1024 * 1024,
    2 * 1024 * 1024,
    4 * 1024 * 1024,
] as const;
export const STREAM_WRITE_BATCH_BYTES_DEFAULT = 1024 * 1024;

export type SettingKey = keyof AppSettings;

export type SettingScope = "general" | "transfer";

export interface SettingDefinition<K extends SettingKey = SettingKey> {
    publicKey: K;
    scope: SettingScope;
    storageKey: string;
    sensitive?: boolean;
}

export const APP_SETTINGS = {
    "general.runOnStartup": {
        publicKey: "general.runOnStartup",
        scope: "general",
        storageKey: "runOnStartup",
    },
    "general.runInBackground": {
        publicKey: "general.runInBackground",
        scope: "general",
        storageKey: "runInBackground",
    },
    "general.lastDownloadPath": {
        publicKey: "general.lastDownloadPath",
        scope: "general",
        storageKey: "lastDownloadPath",
    },
    "general.createCollectionSubfolder": {
        publicKey: "general.createCollectionSubfolder",
        scope: "general",
        storageKey: "createCollectionSubfolder",
    },
    "general.logLevel": {
        publicKey: "general.logLevel",
        scope: "general",
        storageKey: "logLevel",
    },
    "general.theme": {
        publicKey: "general.theme",
        scope: "general",
        storageKey: "theme",
    },
    "general.powerSaveBlockInTransfer": {
        publicKey: "general.powerSaveBlockInTransfer",
        scope: "general",
        storageKey: "powerSaveBlockInTransfer",
    },
    "transfer.segmentPoolSize": {
        publicKey: "transfer.segmentPoolSize",
        scope: "transfer",
        storageKey: "transfer.segmentPoolSize",
    },
    "transfer.maxChunkRetries": {
        publicKey: "transfer.maxChunkRetries",
        scope: "transfer",
        storageKey: "transfer.maxChunkRetries",
    },
    "transfer.streamWriteBatchBytes": {
        publicKey: "transfer.streamWriteBatchBytes",
        scope: "transfer",
        storageKey: "transfer.streamWriteBatchBytes",
    },
    "transfer.startupResumeMode": {
        publicKey: "transfer.startupResumeMode",
        scope: "transfer",
        storageKey: "transfer.startupResumeMode",
    },
} as const satisfies Record<SettingKey, SettingDefinition>;
