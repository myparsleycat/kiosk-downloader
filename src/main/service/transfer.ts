import type { KioskDownloader } from "..";

import { BandwidthLimiter } from "./bandwidth-limiter";
import { syncMainWindowProgressBar } from "./os-progress-bar";
import { shutdownSystem } from "./util";

const MIB = 1024 * 1024;

export class TransferService {
    private shutdownRequested = false;
    private shutdownScheduling = false;

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
            await this.kd.setting.get("transfer.downloadBandwidthLimitMibps"),
        );
        this.setUploadBandwidthLimitMibps(
            await this.kd.setting.get("transfer.uploadBandwidthLimitMibps"),
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
            (await this.kd.setting.get("general.powerSaveBlockInTransfer"));

        this.syncMainWindowProgressBar();

        try {
            this.kd.lib.utils.preventAppSuspension(shouldBlock);
        } catch (error) {
            const operation = shouldBlock ? "start" : "stop";
            this.kd.logger.error(error, `TransferService:preventAppSuspension:${operation}`);
        }
    }

    public async maybeShutdownAfterTransfer() {
        if (this.shutdownRequested || this.shutdownScheduling) {
            return;
        }
        if (!(await this.kd.setting.get("general.shutdownAfterTransfer"))) {
            return;
        }
        if (this.shutdownRequested || this.shutdownScheduling) {
            return;
        }
        if (
            this.kd.service.download.listOsProgressTransfers().length > 0 ||
            this.kd.service.upload.listOsProgressTransfers().length > 0
        ) {
            return;
        }

        this.shutdownScheduling = true;
        try {
            await this.kd.setting.set("general.shutdownAfterTransfer", false);
            this.kd.logger.info("TransferService:maybeShutdownAfterTransfer:shutdown");
            if (shutdownSystem()) {
                this.shutdownRequested = true;
            }
        } finally {
            this.shutdownScheduling = false;
        }
    }
}

export default TransferService;
