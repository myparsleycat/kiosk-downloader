import type {
    CreateDownloadPayload,
    ListZipEntriesPayload,
    PrepareDownloadPayload,
    ResumePayload,
} from "@shared/types";

import type { KioskDownloader } from "../..";

import { rh } from "../helper";

export function registerDownloadHandlers(kd: KioskDownloader) {
    rh("download:discardDraft", (payload: { draftId?: string }) =>
        kd.service.download.discardDraft(payload),
    );
    rh("download:prepare", (payload: PrepareDownloadPayload) =>
        kd.service.download.prepare(payload),
    );
    rh("download:listZipEntries", (payload: ListZipEntriesPayload) =>
        kd.service.download.listZipEntries(payload),
    );
    rh("download:create", (payload: CreateDownloadPayload) => kd.service.download.create(payload));
    rh("download:list", () => kd.service.download.list());
    rh("download:pauseCollection", (id: string) => kd.service.download.pauseCollection(id));
    rh("download:resumeCollection", (id: string, options?: ResumePayload) =>
        kd.service.download.resumeCollection(id, options),
    );
    rh("download:pauseFile", (downloadId: string, fileId: string) =>
        kd.service.download.pauseFile(downloadId, fileId),
    );
    rh("download:resumeFile", (downloadId: string, fileId: string, options?: ResumePayload) =>
        kd.service.download.resumeFile(downloadId, fileId, options),
    );
    rh("download:includeFile", (downloadId: string, fileId: string) =>
        kd.service.download.includeFile(downloadId, fileId),
    );
    rh("download:includeFolder", (downloadId: string, folderPath: string) =>
        kd.service.download.includeFolder(downloadId, folderPath),
    );
    rh("download:remove", (id: string) => kd.service.download.remove(id));
    rh("download:openFolder", (id: string) => kd.service.download.openFolder(id));
    rh("download:exportCollection", (id: string) => kd.service.download.exportCollection(id));
    rh("download:importCollection", () => kd.service.download.importCollection());
    rh("download:readShareFile", (payload?: { bytes: Uint8Array }) =>
        kd.service.download.readShareFile(payload),
    );
}
