import type { KioskDownloader } from "..";

export class TransferService {
    private isPowerSaveBlockerActive = false;

    public constructor(private readonly kd: KioskDownloader) {}

    public async refreshPowerSaveBlock() {
        const shouldBlock =
            (this.kd.service.download.hasActiveTransfers() ||
                this.kd.service.upload.hasActiveTransfers()) &&
            (await this.kd.setting.general.getPowerSaveBlockInTransfer());

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
