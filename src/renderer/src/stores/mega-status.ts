import { getIpcErrorCause } from "@shared/download-errors";
import { toast } from "sonner";
import { create } from "zustand";

type MegaStatusStore = {
    autoResume: boolean;
    loggedIn: boolean;
};

/** App-wide Mega state the download list needs; kept in sync by `subscribeMegaStatus`. */
export const useMegaStatus = create<MegaStatusStore>(() => ({
    autoResume: false,
    loggedIn: false,
}));

export function subscribeMegaStatus() {
    void window.api
        .invoke("setting:getMany", ["transfer.megaQuotaAutoResume"] as const)
        .then((values) =>
            useMegaStatus.setState({ autoResume: values["transfer.megaQuotaAutoResume"] }),
        )
        .catch((error: unknown) => {
            toast.error("Mega 자동 재개 설정을 불러오지 못했습니다", {
                description: getIpcErrorCause(error),
            });
        });
    void window.api
        .invoke("mega:getAccount")
        .then((account) => useMegaStatus.setState({ loggedIn: account.loggedIn }))
        .catch((error: unknown) => {
            toast.error("Mega 계정 정보를 불러오지 못했습니다", {
                description: getIpcErrorCause(error),
            });
        });

    const offSetting = window.api.on("setting:update", ({ key, value }) => {
        if (key === "transfer.megaQuotaAutoResume") {
            useMegaStatus.setState({ autoResume: Boolean(value) });
        }
    });
    const offAccount = window.api.on("mega:accountChanged", (account) =>
        useMegaStatus.setState({ loggedIn: account.loggedIn }),
    );
    return () => {
        offSetting();
        offAccount();
    };
}
