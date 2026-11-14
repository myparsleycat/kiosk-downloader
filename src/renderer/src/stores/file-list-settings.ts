import { getIpcErrorCause } from "@shared/download-errors";
import { toast } from "sonner";
import { create } from "zustand";

export const useFileListSettings = create(() => ({
    foldersFirst: true,
}));

export function subscribeFileListSettings() {
    let updated = false;
    void window.api
        .invoke("setting:getMany", ["general.foldersFirst"] as const)
        .then((values) => {
            if (updated) return;
            useFileListSettings.setState({ foldersFirst: values["general.foldersFirst"] ?? true });
        })
        .catch((error: unknown) => {
            toast.error("파일 목록 설정을 불러오지 못했습니다", {
                description: getIpcErrorCause(error),
            });
        });

    return window.api.on("setting:update", ({ key, value }) => {
        if (key === "general.foldersFirst" && typeof value === "boolean") {
            updated = true;
            useFileListSettings.setState({ foldersFirst: value });
        }
    });
}
