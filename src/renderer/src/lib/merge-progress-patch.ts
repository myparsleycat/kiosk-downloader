import type {
    DownloadItem,
    DownloadProgressPatch,
    UploadItem,
    UploadProgressPatch,
} from "@shared/types";

type ProgressItem = DownloadItem | UploadItem;
type ProgressPatch = DownloadProgressPatch | UploadProgressPatch;

export function mergeProgressPatch<TItem extends ProgressItem, TPatch extends ProgressPatch>(
    item: TItem,
    patch: TPatch,
): TItem {
    return {
        ...item,
        progress: { ...item.progress, ...patch.progress },
        summary: patch.summary,
        status: patch.status,
        speedBps: patch.speedBps ?? undefined,
        elapsedMs: patch.elapsedMs,
        updatedAt: patch.updatedAt,
    } as TItem;
}

export function mergeProgressPatchIntoItems<
    TItem extends ProgressItem,
    TPatch extends ProgressPatch,
>(items: TItem[], patch: TPatch): TItem[] {
    const index = items.findIndex((item) => item.id === patch.id);
    if (index === -1) return items;

    const next = [...items];
    next[index] = mergeProgressPatch(items[index], patch);
    return next;
}

export function upsertItem<TItem extends { id: string }>(items: TItem[], item: TItem): TItem[] {
    const index = items.findIndex((entry) => entry.id === item.id);
    if (index === -1) return [item, ...items];

    const next = [...items];
    next[index] = item;
    return next;
}

export function applyPendingItems<TItem extends { id: string }>(
    items: TItem[],
    pending: ReadonlyMap<string, TItem>,
): TItem[] {
    let next = items;
    for (const item of pending.values()) {
        next = upsertItem(next, item);
    }
    return next;
}
