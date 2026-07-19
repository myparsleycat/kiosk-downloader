import type {
    DownloadItem,
    DownloadProgressPatch,
    UploadItem,
    UploadProgressPatch,
} from "@shared/types";
import * as React from "react";
import { toast } from "sonner";

import {
    applyPendingItems,
    mergeProgressPatchIntoItems,
    upsertItem,
} from "../lib/merge-progress-patch";

interface TransferItemsSource<TItem extends { id: string }, TPatch> {
    load: () => Promise<TItem[]>;
    subscribeItems: (listener: (items: TItem[]) => void) => () => void;
    subscribeItem: (listener: (item: TItem) => void) => () => void;
    subscribeProgress: (listener: (patch: TPatch) => void) => () => void;
    mergeProgress: (items: TItem[], patch: TPatch) => TItem[];
    loadErrorMessage: string;
}

export const downloadItemsSource: TransferItemsSource<DownloadItem, DownloadProgressPatch> = {
    load: () => window.api.invoke("download:list"),
    subscribeItems: (listener) => window.api.on("download:update", listener),
    subscribeItem: (listener) => window.api.on("download:item-update", listener),
    subscribeProgress: (listener) => window.api.on("download:progress-update", listener),
    mergeProgress: mergeProgressPatchIntoItems,
    loadErrorMessage: "다운로드 목록을 불러오지 못했습니다",
};

export const uploadItemsSource: TransferItemsSource<UploadItem, UploadProgressPatch> = {
    load: () => window.api.invoke("upload:list"),
    subscribeItems: (listener) => window.api.on("upload:update", listener),
    subscribeItem: (listener) => window.api.on("upload:item-update", listener),
    subscribeProgress: (listener) => window.api.on("upload:progress-update", listener),
    mergeProgress: mergeProgressPatchIntoItems,
    loadErrorMessage: "업로드 목록을 불러오지 못했습니다",
};

export function useTransferItems<TItem extends { id: string }, TPatch>(
    source: TransferItemsSource<TItem, TPatch>,
) {
    const [items, setItems] = React.useState<TItem[]>([]);

    React.useEffect(() => {
        let mounted = true;
        let initialized = false;
        const pendingItems = new Map<string, TItem>();

        const offItems = source.subscribeItems((nextItems) => {
            if (initialized) {
                setItems(nextItems);
                return;
            }
            for (const item of nextItems) pendingItems.set(item.id, item);
        });
        const offItem = source.subscribeItem((item) => {
            if (initialized) {
                setItems((previous) => upsertItem(previous, item));
                return;
            }
            pendingItems.set(item.id, item);
        });
        const offProgress = source.subscribeProgress((patch) => {
            if (!initialized) return;
            React.startTransition(() => {
                setItems((previous) => source.mergeProgress(previous, patch));
            });
        });

        void source
            .load()
            .then((loadedItems) => {
                if (!mounted) return;
                initialized = true;
                setItems(applyPendingItems(loadedItems, pendingItems));
                pendingItems.clear();
            })
            .catch((error) => {
                if (!mounted) return;
                initialized = true;
                setItems(applyPendingItems([], pendingItems));
                pendingItems.clear();
                toast.error(source.loadErrorMessage, {
                    description: error instanceof Error ? error.message : String(error),
                });
            });

        return () => {
            mounted = false;
            offItems();
            offItem();
            offProgress();
        };
    }, [source]);

    return items;
}
