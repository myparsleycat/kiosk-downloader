import type { KioskDownloader } from "..";

import { BandwidthLimiter } from "./bandwidth-limiter";
import { syncMainWindowProgressBar } from "./os-progress-bar";

const MIB = 1024 * 1024;

export class TransferService {
    private isPowerSaveBlockerActive = false;

    public readonly downloadBandwidth = new BandwidthLimiter();
    public readonly uploadBandwidth = new BandwidthLimiter();

    public constructor(private readonly kd: KioskDownloader) {}

    public setDownloadBandwidthLimitMibps(mibps: number) {
        this.downloadBandwidth.setRateBps(mibps > 0 ? mibps * MIB : 0);
    }

    public setUploadBandwidthLimitMibps(mibps: number) {
        this.uploadBandwidth.setRateBps(mibps > 0 ? mibps * MIB : 0);
    }

    public async applyBandwidthLimitsFromSettings() {
        this.setDownloadBandwidthLimitMibps(
            await this.kd.setting.transfer.getDownloadBandwidthLimitMibps(),
        );
        this.setUploadBandwidthLimitMibps(
            await this.kd.setting.transfer.getUploadBandwidthLimitMibps(),
        );
    }

    public syncMainWindowProgressBar() {
        const transfers = [
            ...this.kd.service.download.listOsProgressTransfers(),
            ...this.kd.service.upload.listOsProgressTransfers(),
        ];
        syncMainWindowProgressBar(this.kd.window.main.window, transfers);
    }

    public async refreshPowerSaveBlock() {
        const shouldBlock =
            (this.kd.service.download.hasActiveTransfers() ||
                this.kd.service.upload.hasActiveTransfers()) &&
            (await this.kd.setting.general.getPowerSaveBlockInTransfer());

        this.syncMainWindowProgressBar();

        if (shouldBlock && !this.isPowerSaveBlockerActive) {
            try {
                await this.kd.lib.utils.preventAppSuspension(true);
                this.isPowerSaveBlockerActive = true;
            } catch (error) {
                this.kd.logger.error(error, "TransferService:preventAppSuspension:start");
            }
            return;
        }

        if (!shouldBlock && this.isPowerSaveBlockerActive) {
            try {
                await this.kd.lib.utils.preventAppSuspension(false);
                this.isPowerSaveBlockerActive = false;
            } catch (error) {
                this.kd.logger.error(error, "TransferService:preventAppSuspension:stop");
            }
        }
    }
}

export default TransferService;
