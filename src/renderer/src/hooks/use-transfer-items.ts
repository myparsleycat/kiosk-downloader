import type {
    DownloadItem,
    TransferItemChange,
    TransferItemShape,
    TransferListSnapshot,
    UploadItem,
} from "@shared/types";
import * as React from "react";
import { toast } from "sonner";

import { applyTransferItemChange, applyTransferItemChanges } from "../lib/merge-progress-patch";

interface TransferItemsSource<TItem extends TransferItemShape> {
    load: () => Promise<TransferListSnapshot<TItem>>;
    subscribe: (listener: (change: TransferItemChange<TItem>) => void) => () => void;
    loadErrorMessage: string;
}

export const downloadItemsSource: TransferItemsSource<DownloadItem> = {
    load: () => window.api.invoke("download:list"),
    subscribe: (listener) => window.api.on("download:changed", listener),
    loadErrorMessage: "다운로드 목록을 불러오지 못했습니다",
};

export const uploadItemsSource: TransferItemsSource<UploadItem> = {
    load: () => window.api.invoke("upload:list"),
    subscribe: (listener) => window.api.on("upload:changed", listener),
    loadErrorMessage: "업로드 목록을 불러오지 못했습니다",
};

export function useTransferItems<TItem extends TransferItemShape>(
    source: TransferItemsSource<TItem>,
) {
    const [items, setItems] = React.useState<TItem[]>([]);

    React.useEffect(() => {
        let mounted = true;
        let loading = true;
        let revision = 0;
        let current: TItem[] = [];
        const pendingChanges: TransferItemChange<TItem>[] = [];

        const commit = (snapshot: TransferListSnapshot<TItem>) => {
            revision = snapshot.revision;
            current = snapshot.items;
            setItems(current);
            pendingChanges.length = 0;
        };

        const load = (reportError: boolean) => {
            loading = true;
            void source
                .load()
                .then((snapshot) => {
                    if (!mounted) return;
                    loading = false;
                    commit(applyTransferItemChanges(snapshot, pendingChanges));
                })
                .catch((error) => {
                    if (!mounted) return;
                    loading = false;
                    commit(applyTransferItemChanges({ revision, items: current }, pendingChanges));
                    if (!reportError) return;
                    toast.error(source.loadErrorMessage, {
                        description: error instanceof Error ? error.message : String(error),
                    });
                });
        };

        const unsubscribe = source.subscribe((change) => {
            if (loading) {
                pendingChanges.push(change);
                return;
            }
            if (change.revision <= revision) return;
            // A patch for an item this list never received means its baseline was missed
            // (e.g. a failed load); only a fresh snapshot can recover it.
            if (change.kind === "patch" && !current.some((item) => item.id === change.id)) {
                pendingChanges.push(change);
                load(false);
                return;
            }
            revision = change.revision;
            current = applyTransferItemChange(current, change);
            // Progress must stay high-priority; startTransition defers bar updates under load.
            setItems(current);
        });

        load(true);

        return () => {
            mounted = false;
            unsubscribe();
        };
    }, [source]);

    return items;
}
