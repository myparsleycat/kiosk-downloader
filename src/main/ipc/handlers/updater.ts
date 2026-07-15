import type { KioskDownloader } from "../..";

import { rh } from "../helper";

export function registerUpdaterHandlers(kd: KioskDownloader) {
    rh("updater:getStatus", async () => await kd.service.updater.getStatus());

    rh("updater:checkForUpdates", async () => {
        try {
            await kd.service.updater.checkForUpdates(true);
        } catch (error) {
            kd.logger.error(error, "updater:checkForUpdates");
            throw error;
        }
    });

    rh("updater:downloadUpdate", async () => {
        try {
            await kd.service.updater.downloadUpdate();
        } catch (error) {
            kd.logger.error(error, "updater:downloadUpdate");
            throw error;
        }
    });

    rh("updater:installUpdate", async () => {
        try {
            await kd.service.updater.installUpdate();
        } catch (error) {
            kd.logger.error(error, "updater:installUpdate");
            throw error;
        }
    });

    rh("updater:dismissUpdateDialog", () => {
        kd.service.updater.dismissUpdateDialog();
    });

    rh("updater:openDownloadPage", async () => {
        try {
            await kd.service.updater.openDownloadPage();
        } catch (error) {
            kd.logger.error(error, "updater:openDownloadPage");
            throw error;
        }
    });
}
