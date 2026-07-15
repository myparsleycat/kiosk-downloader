import type { DownloadService } from "@main/service/download";
import type { Updater } from "@main/service/updater";
import type { UploadService } from "@main/service/upload";
import type {
    copyStr,
    getAppStatus,
    getClipboardFiles,
    getPathMetadata,
    mkdir,
    openCmd,
    openExternal,
    openPath,
    showModal,
    showOpenDialog,
    showSaveDialog,
    trash,
} from "@main/service/util";

import type { AppSettings, SettingKey } from "./settings";
import type { ExpandPathsResult, TitleBarOverlaySyncOptions } from "./types";

export type IpcHandlers = {
    "download:create": DownloadService["create"];
    "download:exportCollection": DownloadService["exportCollection"];
    "download:importCollection": DownloadService["importCollection"];
    "download:includeFile": DownloadService["includeFile"];
    "download:includeFolder": DownloadService["includeFolder"];
    "download:list": DownloadService["list"];
    "download:listZipEntries": DownloadService["listZipEntries"];
    "download:loadCollection": DownloadService["loadCollection"];
    "download:openFolder": DownloadService["openFolder"];
    "download:pauseCollection": DownloadService["pauseCollection"];
    "download:pauseFile": DownloadService["pauseFile"];
    "download:probeCollection": DownloadService["probeCollection"];
    "download:remove": DownloadService["remove"];
    "download:resumeCollection": DownloadService["resumeCollection"];
    "download:resumeFile": DownloadService["resumeFile"];
    "setting:getMany": <K extends readonly SettingKey[] = readonly SettingKey[]>(
        keys?: K,
    ) => Promise<{ [P in K[number]]: AppSettings[P] }>;
    "setting:set": <K extends SettingKey>(key: K, value: AppSettings[K]) => Promise<AppSettings[K]>;
    "updater:checkForUpdates": () => Promise<void>;
    "updater:dismissUpdateDialog": () => void;
    "updater:downloadUpdate": () => Promise<void>;
    "updater:getStatus": Updater["getStatus"];
    "updater:installUpdate": () => Promise<void>;
    "updater:openDownloadPage": () => Promise<void>;
    "upload:clearDraftSources": UploadService["clearDraftSources"];
    "upload:copyLink": UploadService["copyLink"];
    "upload:create": UploadService["create"];
    "upload:expandPaths": UploadService["expandPaths"];
    "upload:list": UploadService["list"];
    "upload:pause": UploadService["pauseUpload"];
    "upload:pauseFile": UploadService["pauseFile"];
    "upload:pickFiles": (maxFiles?: number) => Promise<ExpandPathsResult>;
    "upload:pickFolder": (maxFiles?: number) => Promise<ExpandPathsResult>;
    "upload:remove": UploadService["remove"];
    "upload:removeDraftSources": UploadService["removeDraftSources"];
    "upload:resume": UploadService["resumeUpload"];
    "upload:resumeFile": UploadService["resumeFile"];
    "upload:solveTurnstile": UploadService["solveTurnstile"];
    "util:copyStr": typeof copyStr;
    "util:fs:metadata": typeof getPathMetadata;
    "util:fs:mkdir": typeof mkdir;
    "util:fs:trash": typeof trash;
    "util:getAppStatus": typeof getAppStatus;
    "util:getClipboardFiles": typeof getClipboardFiles;
    "util:openCmd": typeof openCmd;
    "util:openExternal": typeof openExternal;
    "util:openPath": typeof openPath;
    "util:showModal": typeof showModal;
    "util:showOpenDialog": typeof showOpenDialog;
    "util:showSaveDialog": typeof showSaveDialog;
    "window:syncTitleBarOverlay": (options: TitleBarOverlaySyncOptions) => void;
};
