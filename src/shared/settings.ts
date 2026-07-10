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
    "general.asciiFilenames": boolean;
    "general.logLevel": SettingLogLevel;
    "general.theme": SettingTheme;
    "general.powerSaveBlockInTransfer": boolean;
    "general.shutdownAfterTransfer": boolean;
    "transfer.segmentPoolSize": number;
    "transfer.maxChunkRetries": number;
    "transfer.uploadMaxChunkRetries": number;
    "transfer.streamWriteBatchBytes": number;
    "transfer.inflateBufferBytes": number;
    "transfer.startupResumeMode": StartupResumeMode;
    "transfer.uploadStartupResumeMode": StartupResumeMode;
    "transfer.downloadBandwidthLimitMibps": number;
    "transfer.uploadBandwidthLimitMibps": number;
}

export const CHUNK_RETRY_MIN = 3;
export const CHUNK_RETRY_MAX = 10;
export const CHUNK_RETRY_DEFAULT = 5;

export const UPLOAD_CHUNK_RETRY_MIN = 1;
export const UPLOAD_CHUNK_RETRY_MAX = 3;
export const UPLOAD_CHUNK_RETRY_DEFAULT = 2;

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

export const INFLATE_BUFFER_BYTES_OPTIONS = [
    1024 * 1024,
    2 * 1024 * 1024,
    4 * 1024 * 1024,
    8 * 1024 * 1024,
] as const;
export const INFLATE_BUFFER_BYTES_DEFAULT = 4 * 1024 * 1024;

export const BANDWIDTH_LIMIT_MIBPS_MIN = 0;
export const BANDWIDTH_LIMIT_MIBPS_MAX = 1024;
export const BANDWIDTH_LIMIT_MIBPS_DEFAULT = 0;

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
    "general.asciiFilenames": {
        publicKey: "general.asciiFilenames",
        scope: "general",
        storageKey: "asciiFilenames",
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
    "general.shutdownAfterTransfer": {
        publicKey: "general.shutdownAfterTransfer",
        scope: "general",
        storageKey: "shutdownAfterTransfer",
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
    "transfer.uploadMaxChunkRetries": {
        publicKey: "transfer.uploadMaxChunkRetries",
        scope: "transfer",
        storageKey: "transfer.uploadMaxChunkRetries",
    },
    "transfer.streamWriteBatchBytes": {
        publicKey: "transfer.streamWriteBatchBytes",
        scope: "transfer",
        storageKey: "transfer.streamWriteBatchBytes",
    },
    "transfer.inflateBufferBytes": {
        publicKey: "transfer.inflateBufferBytes",
        scope: "transfer",
        storageKey: "transfer.inflateBufferBytes",
    },
    "transfer.startupResumeMode": {
        publicKey: "transfer.startupResumeMode",
        scope: "transfer",
        storageKey: "transfer.startupResumeMode",
    },
    "transfer.uploadStartupResumeMode": {
        publicKey: "transfer.uploadStartupResumeMode",
        scope: "transfer",
        storageKey: "transfer.uploadStartupResumeMode",
    },
    "transfer.downloadBandwidthLimitMibps": {
        publicKey: "transfer.downloadBandwidthLimitMibps",
        scope: "transfer",
        storageKey: "transfer.downloadBandwidthLimitMibps",
    },
    "transfer.uploadBandwidthLimitMibps": {
        publicKey: "transfer.uploadBandwidthLimitMibps",
        scope: "transfer",
        storageKey: "transfer.uploadBandwidthLimitMibps",
    },
} as const satisfies Record<SettingKey, SettingDefinition>;
