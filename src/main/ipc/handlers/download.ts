import type {
    CreateDownloadPayload,
    LoadCollectionPayload,
    ProbeCollectionPayload,
    ResumePayload,
} from "@shared/types";

import type { KioskDownloader } from "../..";

import { rh } from "../helper";

export function registerDownloadHandlers(kd: KioskDownloader) {
    rh("download:loadCollection", (payload: LoadCollectionPayload) =>
        kd.service.download.loadCollection(payload),
    );
    rh("download:probeCollection", (payload: ProbeCollectionPayload) =>
        kd.service.download.probeCollection(payload),
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
}
