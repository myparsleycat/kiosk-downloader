import type {
    DownloadItem,
    TransferItemChange,
    TransferListSnapshot,
    UploadItem,
} from "@shared/types";
import * as React from "react";
import { toast } from "sonner";

import { applyTransferItemChange, applyTransferItemChanges } from "../lib/merge-progress-patch";

interface TransferItemsSource<TItem extends { id: string }> {
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

export function useTransferItems<TItem extends { id: string }>(source: TransferItemsSource<TItem>) {
    const [items, setItems] = React.useState<TItem[]>([]);

    React.useEffect(() => {
        let mounted = true;
        let initialized = false;
        let revision = 0;
        const pendingChanges: TransferItemChange<TItem>[] = [];

        const unsubscribe = source.subscribe((change) => {
            if (!initialized) {
                pendingChanges.push(change);
                return;
            }
            if (change.revision <= revision) return;
            revision = change.revision;
            // Progress must stay high-priority; startTransition defers bar updates under load.
            setItems((previous) => applyTransferItemChange(previous, change));
        });

        void source
            .load()
            .then((snapshot) => {
                if (!mounted) return;
                initialized = true;
                const current = applyTransferItemChanges(snapshot, pendingChanges);
                revision = current.revision;
                setItems(current.items);
                pendingChanges.length = 0;
            })
            .catch((error) => {
                if (!mounted) return;
                initialized = true;
                const current = applyTransferItemChanges(
                    { revision: 0, items: [] },
                    pendingChanges,
                );
                revision = current.revision;
                setItems(current.items);
                pendingChanges.length = 0;
                toast.error(source.loadErrorMessage, {
                    description: error instanceof Error ? error.message : String(error),
                });
            });

        return () => {
            mounted = false;
            unsubscribe();
        };
    }, [source]);

    return items;
}
