import { REQUEST_POOL_SIZE_DEFAULT } from "@shared/settings";
import type { TransferDirection, TransferProviderRequestId } from "@shared/settings";

import type { KioskDownloader } from "..";

import { BandwidthLimiter } from "./bandwidth-limiter";
import { syncMainWindowProgressBar, type OsProgressTransfer } from "./os-progress-bar";
import { TransferScheduler, type RequestPoolUsageChange } from "./transfer-request-pool";
import { shutdownSystem } from "./util";

const MIB = 1024 * 1024;

export class TransferService {
    private shutdownRequested = false;
    private shutdownScheduling = false;
    private readonly requestPoolUsageListeners = new Set<
        (change: RequestPoolUsageChange) => void
    >();
    private activitySources: {
        listOsProgressTransfers: () => OsProgressTransfer[];
        hasActiveTransfers: () => boolean;
    } = {
        listOsProgressTransfers: () => [],
        hasActiveTransfers: () => false,
    };

    public readonly downloadBandwidth = new BandwidthLimiter();
    public readonly uploadBandwidth = new BandwidthLimiter();
    public readonly requestPool = new TransferScheduler(REQUEST_POOL_SIZE_DEFAULT, (change) => {
        for (const listener of this.requestPoolUsageListeners) {
            listener(change);
        }
    });

    public constructor(private readonly kd: KioskDownloader) {}

    public bindActivitySources(sources: typeof this.activitySources) {
        this.activitySources = sources;
    }

    public setDownloadBandwidthLimitMibps(mibps: number) {
        this.downloadBandwidth.setRateBps(mibps > 0 ? mibps * MIB : 0);
    }

    public setUploadBandwidthLimitMibps(mibps: number) {
        this.uploadBandwidth.setRateBps(mibps > 0 ? mibps * MIB : 0);
    }

    public setRequestPoolSize(size: number) {
        this.requestPool.resize(size);
    }

    public onRequestPoolUsageChange(listener: (change: RequestPoolUsageChange) => void) {
        this.requestPoolUsageListeners.add(listener);
        return () => {
            this.requestPoolUsageListeners.delete(listener);
        };
    }

    public getRequestPoolUsageSum(
        direction: TransferDirection,
        providerId: TransferProviderRequestId,
        collectionIds: string[],
    ) {
        let inFlight = 0;
        let pending = 0;
        let found = false;
        for (const collectionId of collectionIds) {
            const usage = this.requestPool.getCollectionUsage({
                direction,
                providerId,
                collectionId,
            });
            if (!usage) {
                continue;
            }
            found = true;
            inFlight += usage.inFlight;
            pending += usage.pending;
        }
        return found ? { inFlight, pending } : undefined;
    }

    public async applyBandwidthLimitsFromSettings() {
        this.setDownloadBandwidthLimitMibps(
            await this.kd.setting.get("transfer.downloadBandwidthLimitMibps"),
        );
        this.setUploadBandwidthLimitMibps(
            await this.kd.setting.get("transfer.uploadBandwidthLimitMibps"),
        );
    }

    public async applyRequestPoolSettings() {
        this.setRequestPoolSize(await this.kd.setting.get("transfer.requestPoolSize"));
    }

    public syncMainWindowProgressBar() {
        const transfers = this.activitySources.listOsProgressTransfers();
        syncMainWindowProgressBar(this.kd.window.main.window, transfers);
    }

    public async refreshPowerSaveBlock() {
        const shouldBlock =
            this.activitySources.hasActiveTransfers() &&
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
        if (this.activitySources.listOsProgressTransfers().length > 0) {
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
