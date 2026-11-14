import type { MegaLoginPayload } from "@shared/types";

import type { KioskDownloader } from "../..";

import { withLoggedError } from "../../lib/logged-error";
import { rh } from "../helper";

export function registerMegaHandlers(kd: KioskDownloader) {
    rh("mega:getAccount", () => kd.service.mega.getAccount());
    rh("mega:login", (payload: MegaLoginPayload) => kd.service.mega.login(payload));
    rh("mega:logout", () => kd.service.mega.logout());
    rh("mega:refreshAccount", () =>
        withLoggedError(kd.logger, "mega:refreshAccount", {}, () =>
            kd.service.mega.refreshAccount(),
        ),
    );
}
