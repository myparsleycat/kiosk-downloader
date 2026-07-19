import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "..";

import { Utils } from "./utils";

const powerSaveBlocker = vi.hoisted(() => ({
    isStarted: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
}));

vi.mock("electron", () => ({ powerSaveBlocker }));

describe("Utils.preventAppSuspension", () => {
    beforeEach(() => {
        powerSaveBlocker.isStarted.mockReset();
        powerSaveBlocker.start.mockReset();
        powerSaveBlocker.stop.mockReset();
        powerSaveBlocker.start.mockReturnValueOnce(1).mockReturnValueOnce(2);
        powerSaveBlocker.isStarted.mockReturnValue(true);
    });

    it("does not start a second blocker while the current blocker is active", () => {
        const utils = new Utils({} as KioskDownloader);

        expect(utils.preventAppSuspension(true)).toBe(1);
        expect(utils.preventAppSuspension(true)).toBe(1);
        expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    });

    it("replaces a stale blocker ID", () => {
        const utils = new Utils({} as KioskDownloader);

        expect(utils.preventAppSuspension(true)).toBe(1);
        powerSaveBlocker.isStarted.mockReturnValue(false);

        expect(utils.preventAppSuspension(true)).toBe(2);
        expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2);
    });

    it("stops an active blocker once and makes repeated stops idempotent", () => {
        const utils = new Utils({} as KioskDownloader);
        utils.preventAppSuspension(true);

        expect(utils.preventAppSuspension(false)).toBeNull();
        expect(utils.preventAppSuspension(false)).toBeNull();
        expect(powerSaveBlocker.stop).toHaveBeenCalledOnce();
        expect(powerSaveBlocker.stop).toHaveBeenCalledWith(1);
    });
});
