import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "..";

import { TransferService } from "./transfer";

const shutdownSystem = vi.hoisted(() => vi.fn());

vi.mock("./util", () => ({
    shutdownSystem,
}));

describe("TransferService.maybeShutdownAfterTransfer", () => {
    beforeEach(() => {
        shutdownSystem.mockReset();
        shutdownSystem.mockReturnValue(true);
    });

    it("does not shut down when the setting is off", async () => {
        const { service, getShutdownAfterTransfer } = createService({
            enabled: false,
            downloadTransfers: [],
            uploadTransfers: [],
        });

        await service.maybeShutdownAfterTransfer();

        expect(getShutdownAfterTransfer).toHaveBeenCalled();
        expect(shutdownSystem).not.toHaveBeenCalled();
    });

    it("does not shut down when download progress rows remain", async () => {
        const { service } = createService({
            enabled: true,
            downloadTransfers: [{ status: "pending" }],
            uploadTransfers: [],
        });

        await service.maybeShutdownAfterTransfer();

        expect(shutdownSystem).not.toHaveBeenCalled();
    });

    it("does not shut down when upload progress rows remain", async () => {
        const { service } = createService({
            enabled: true,
            downloadTransfers: [],
            uploadTransfers: [{ status: "paused" }],
        });

        await service.maybeShutdownAfterTransfer();

        expect(shutdownSystem).not.toHaveBeenCalled();
    });

    it("does not shut down when an error row remains", async () => {
        const { service } = createService({
            enabled: true,
            downloadTransfers: [{ status: "error" }],
            uploadTransfers: [],
        });

        await service.maybeShutdownAfterTransfer();

        expect(shutdownSystem).not.toHaveBeenCalled();
    });

    it("shuts down once when both sides are idle", async () => {
        const { service } = createService({
            enabled: true,
            downloadTransfers: [],
            uploadTransfers: [],
        });

        await service.maybeShutdownAfterTransfer();
        await service.maybeShutdownAfterTransfer();

        expect(shutdownSystem).toHaveBeenCalledTimes(1);
    });

    it("retries when shutdownSystem does not start a shutdown", async () => {
        shutdownSystem.mockReturnValue(false);
        const { service } = createService({
            enabled: true,
            downloadTransfers: [],
            uploadTransfers: [],
        });

        await service.maybeShutdownAfterTransfer();
        await service.maybeShutdownAfterTransfer();

        expect(shutdownSystem).toHaveBeenCalledTimes(2);
    });
});

function createService(options: {
    enabled: boolean;
    downloadTransfers: unknown[];
    uploadTransfers: unknown[];
}) {
    const getShutdownAfterTransfer = vi.fn(async () => options.enabled);
    const kd = {
        setting: {
            general: {
                getShutdownAfterTransfer,
                getPowerSaveBlockInTransfer: vi.fn(async () => false),
            },
        },
        service: {
            download: {
                hasActiveTransfers: vi.fn(() => false),
                listOsProgressTransfers: vi.fn(() => options.downloadTransfers),
            },
            upload: {
                hasActiveTransfers: vi.fn(() => false),
                listOsProgressTransfers: vi.fn(() => options.uploadTransfers),
            },
        },
        logger: {
            info: vi.fn(),
            error: vi.fn(),
        },
        lib: {
            utils: {
                preventAppSuspension: vi.fn(async () => undefined),
            },
        },
        window: {
            main: {
                window: null,
            },
        },
    } as unknown as KioskDownloader;

    return {
        service: new TransferService(kd),
        getShutdownAfterTransfer,
    };
}
