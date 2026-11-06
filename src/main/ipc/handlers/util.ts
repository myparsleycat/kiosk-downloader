import { getAppStatus, openExternal, showOpenDialog } from "@main/service/util";

import { rh } from "../helper";

export function registerUtilHandlers() {
    rh("util:getAppStatus", getAppStatus);
    rh("util:openExternal", openExternal);
    rh("util:showOpenDialog", showOpenDialog);
}
