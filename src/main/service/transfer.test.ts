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
        const { service, setShutdownAfterTransfer } = createService({
            enabled: true,
            downloadTransfers: [],
            uploadTransfers: [],
        });

        await service.maybeShutdownAfterTransfer();
        await service.maybeShutdownAfterTransfer();

        expect(shutdownSystem).toHaveBeenCalledTimes(1);
        expect(setShutdownAfterTransfer).toHaveBeenCalledWith(false);
        expect(setShutdownAfterTransfer.mock.invocationCallOrder[0]).toBeLessThan(
            shutdownSystem.mock.invocationCallOrder[0],
        );
    });

    it("does not schedule shutdown twice while disabling the setting", async () => {
        const { service, setShutdownAfterTransfer } = createService({
            enabled: true,
            downloadTransfers: [],
            uploadTransfers: [],
        });
        let releaseSettingUpdate: () => void;
        const settingUpdate = new Promise<void>((resolve) => {
            releaseSettingUpdate = resolve;
        });
        setShutdownAfterTransfer.mockImplementation(async () => await settingUpdate);

        const first = service.maybeShutdownAfterTransfer();
        const second = service.maybeShutdownAfterTransfer();
        releaseSettingUpdate!();
        await Promise.all([first, second]);

        expect(setShutdownAfterTransfer).toHaveBeenCalledTimes(1);
        expect(shutdownSystem).toHaveBeenCalledTimes(1);
    });

    it("does not retry when shutdownSystem does not start a shutdown", async () => {
        shutdownSystem.mockReturnValue(false);
        const { service } = createService({
            enabled: true,
            downloadTransfers: [],
            uploadTransfers: [],
        });

        await service.maybeShutdownAfterTransfer();
        await service.maybeShutdownAfterTransfer();

        expect(shutdownSystem).toHaveBeenCalledTimes(1);
    });
});

function createService(options: {
    enabled: boolean;
    downloadTransfers: unknown[];
    uploadTransfers: unknown[];
}) {
    let shutdownAfterTransfer = options.enabled;
    const getShutdownAfterTransfer = vi.fn(async () => shutdownAfterTransfer);
    const setShutdownAfterTransfer = vi.fn(async (enabled: boolean) => {
        shutdownAfterTransfer = enabled;
    });
    const kd = {
        setting: {
            get: vi.fn(async (key: string) => {
                if (key === "general.shutdownAfterTransfer") {
                    return getShutdownAfterTransfer();
                }
                if (key === "general.powerSaveBlockInTransfer") {
                    return false;
                }
                throw new Error(`Unexpected setting get: ${key}`);
            }),
            set: vi.fn(async (key: string, value: unknown) => {
                if (key === "general.shutdownAfterTransfer") {
                    await setShutdownAfterTransfer(value as boolean);
                    return;
                }
                throw new Error(`Unexpected setting set: ${key}`);
            }),
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
        setShutdownAfterTransfer,
    };
}
