import crypto from "crypto";

import { powerSaveBlocker } from "electron";
import fse from "fs-extra";

import type { KioskDownloader } from "..";

export class Utils {
    private kd: KioskDownloader;
    private preventAppSuspensionId: number | null = null;

    constructor(kd: KioskDownloader) {
        this.kd = kd;
    }

    public preventAppSuspension(shouldPrevent: boolean) {
        if (shouldPrevent) {
            if (
                this.preventAppSuspensionId !== null &&
                powerSaveBlocker.isStarted(this.preventAppSuspensionId)
            ) {
                return this.preventAppSuspensionId;
            }
            this.preventAppSuspensionId = powerSaveBlocker.start("prevent-app-suspension");
            return this.preventAppSuspensionId;
        }

        if (
            this.preventAppSuspensionId !== null &&
            powerSaveBlocker.isStarted(this.preventAppSuspensionId)
        ) {
            powerSaveBlocker.stop(this.preventAppSuspensionId);
        }
        this.preventAppSuspensionId = null;
        return null;
    }

    public async getFileHash(path: string) {
        const file = await fse.readFile(path);
        return crypto.createHash("sha256").update(file).digest("hex");
    }
}

export default Utils;
