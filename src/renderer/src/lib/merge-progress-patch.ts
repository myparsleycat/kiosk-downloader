import type { TransferItemChange, TransferListSnapshot } from "@shared/types";

export function upsertItem<TItem extends { id: string }>(items: TItem[], item: TItem): TItem[] {
    const index = items.findIndex((entry) => entry.id === item.id);
    if (index === -1) return [item, ...items];

    const next = [...items];
    next[index] = item;
    return next;
}

export function applyTransferItemChange<TItem extends { id: string }>(
    items: TItem[],
    change: TransferItemChange<TItem>,
): TItem[] {
    if (change.item) return upsertItem(items, change.item);

    const index = items.findIndex((item) => item.id === change.id);
    if (index === -1) return items;
    return items.toSpliced(index, 1);
}

export function applyTransferItemChanges<TItem extends { id: string }>(
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
