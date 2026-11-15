import type { KioskDownloader } from "../..";

import { rh } from "../helper";

export function registerBrowserExtensionHandlers(kd: KioskDownloader) {
    rh("browserExtension:getStatus", () => kd.service.browserExtension.getStatus());
    rh("browserExtension:takeRequests", () => kd.service.browserExtension.takeRequests());
}
