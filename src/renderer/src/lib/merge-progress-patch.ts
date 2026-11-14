import type {
    TransferItemChange,
    TransferItemPatch,
    TransferItemShape,
    TransferListSnapshot,
} from "@shared/types";

export function upsertItem<TItem extends { id: string }>(items: TItem[], item: TItem): TItem[] {
    const index = items.findIndex((entry) => entry.id === item.id);
    if (index === -1) return [item, ...items];

    const next = [...items];
    next[index] = item;
    return next;
}

export function applyTransferItemChange<TItem extends TransferItemShape>(
    items: TItem[],
    change: TransferItemChange<TItem>,
): TItem[] {
    if (change.kind === "upsert") return upsertItem(items, change.item);

    const index = items.findIndex((item) => item.id === change.id);
    if (index === -1) return items;
    if (change.kind === "remove") return items.toSpliced(index, 1);
    return items.with(index, applyTransferItemPatch(items[index], change.patch));
}

export function applyTransferItemChanges<TItem extends TransferItemShape>(
    snapshot: TransferListSnapshot<TItem>,
    changes: readonly TransferItemChange<TItem>[],
): TransferListSnapshot<TItem> {
    return changes
        .toSorted((a, b) => a.revision - b.revision)
        .reduce<TransferListSnapshot<TItem>>((current, change) => {
            if (change.revision <= current.revision) return current;
            return {
                revision: change.revision,
                items: applyTransferItemChange(current.items, change),
            };
        }, snapshot);
}

/** Unchanged progress entries keep their references so memoized rows skip re-rendering. */
function applyTransferItemPatch<TItem extends TransferItemShape>(
    item: TItem,
    patch: TransferItemPatch<TItem>,
): TItem {
    if (!patch.progress && !patch.removedProgress) return { ...item, ...patch.fields };

    const progress = { ...item.progress, ...patch.progress };
    for (const path of patch.removedProgress ?? []) {
        delete progress[path];
    }
    return { ...item, ...patch.fields, progress };
}
