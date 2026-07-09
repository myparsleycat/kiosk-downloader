import { showOpenDialog } from "@main/service/util";
import type { CreateUploadPayload, ExpandPathsResult } from "@shared/types";
import { MAX_UPLOAD_FILES } from "@shared/types";

import type { KioskDownloader } from "../..";

import { rh } from "../helper";

export function registerUploadHandlers(kd: KioskDownloader) {
    rh("upload:solveTurnstile", () => kd.service.upload.solveTurnstile());
    rh("upload:create", (payload: CreateUploadPayload) => kd.service.upload.create(payload));
    rh("upload:list", () => kd.service.upload.list());
    rh("upload:pause", (collectionId: string) => kd.service.upload.pauseUpload(collectionId));
    rh("upload:resume", (collectionId: string, options?: { force?: boolean }) =>
        kd.service.upload.resumeUpload(collectionId, options ?? {}),
    );
    rh("upload:pauseFile", (collectionId: string, fileId: string) =>
        kd.service.upload.pauseFile(collectionId, fileId),
    );
    rh("upload:resumeFile", (collectionId: string, fileId: string, options?: { force?: boolean }) =>
        kd.service.upload.resumeFile(collectionId, fileId, options ?? {}),
    );
    rh("upload:remove", (collectionId: string) => kd.service.upload.remove(collectionId));
    rh("upload:copyLink", (collectionId: string) => kd.service.upload.copyLink(collectionId));
    rh("upload:expandPaths", (paths: string[], maxFiles?: number) =>
        kd.service.upload.expandPaths(paths, maxFiles),
    );
    rh("upload:pickFiles", async (maxFiles?: number): Promise<ExpandPathsResult> => {
        const result = await showOpenDialog({
            properties: ["openFile", "multiSelections"],
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { files: [], truncated: false };
        }
        return kd.service.upload.expandPaths(result.filePaths, maxFiles ?? MAX_UPLOAD_FILES);
    });
    rh("upload:pickFolder", async (maxFiles?: number): Promise<ExpandPathsResult> => {
        const result = await showOpenDialog({
            properties: ["openDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { files: [], truncated: false };
        }
        return kd.service.upload.expandPaths(result.filePaths, maxFiles ?? MAX_UPLOAD_FILES);
    });
    rh("upload:clearDraftSources", () => kd.service.upload.clearDraftSources());
    rh("upload:removeDraftSources", (paths: string[]) =>
        kd.service.upload.removeDraftSources(paths),
    );
}
