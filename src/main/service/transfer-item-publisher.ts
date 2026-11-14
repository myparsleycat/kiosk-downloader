import type { TransferItemChange, TransferItemPatch, TransferItemShape } from "@shared/types";
import { isEqual } from "es-toolkit";

/**
 * Sends each item once as an upsert, then only what changed since the last delivered send. The
 * renderer folds patches onto the list snapshot, so `snapshot()` must route through the same
 * baseline. `send` returns whether the change was delivered; an undelivered change keeps the old
 * baseline so the next publish carries it again.
 */
export class TransferItemPublisher<TItem extends TransferItemShape> {
    private revision = 0;
    private readonly published = new Map<string, TItem>();

    public constructor(private readonly send: (change: TransferItemChange<TItem>) => boolean) {}

    public publish(item: TItem) {
        const previous = this.published.get(item.id);
        const delivered = previous
            ? this.sendPatch(previous, item)
            : this.send({ revision: this.nextRevision(), id: item.id, kind: "upsert", item });
        if (delivered) this.published.set(item.id, item);
    }

    public remove(id: string) {
        this.published.delete(id);
        this.send({ revision: this.nextRevision(), id, kind: "remove" });
    }

    public snapshot(items: TItem[]) {
        const ids = new Set(items.map((item) => item.id));
        for (const id of this.published.keys()) {
            if (!ids.has(id)) this.remove(id);
        }
        for (const item of items) {
            this.publish(item);
            // The snapshot itself delivers the item, even when the event above was not.
            this.published.set(item.id, item);
        }
        return { revision: this.revision, items };
    }

    private sendPatch(previous: TItem, next: TItem) {
        const patch = diffTransferItem(previous, next);
        if (!patch) return false;
        return this.send({ revision: this.nextRevision(), id: next.id, kind: "patch", patch });
    }

    private nextRevision() {
        this.revision += 1;
        return this.revision;
    }
}

export function diffTransferItem<TItem extends TransferItemShape>(
    previous: TItem,
    next: TItem,
): TransferItemPatch<TItem> | null {
    const fields: Partial<TItem> = {};
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof TItem>;
    for (const key of keys) {
        if (key === "id" || key === "progress") continue;
        if (!isEqual(previous[key], next[key])) fields[key] = next[key];
    }

    const progress: Record<string, TItem["progress"][string]> = {};
    for (const [path, entry] of Object.entries(next.progress) as [
        string,
        TItem["progress"][string],
    ][]) {
        if (!isEqual(previous.progress[path], entry)) progress[path] = entry;
    }
    const removedProgress = Object.keys(previous.progress).filter(
        (path) => !Object.hasOwn(next.progress, path),
    );

    const hasProgress = Object.keys(progress).length > 0;
    if (Object.keys(fields).length === 0 && !hasProgress && removedProgress.length === 0) {
        return null;
    }
    return {
        fields: fields as TransferItemPatch<TItem>["fields"],
        ...(hasProgress && { progress }),
        ...(removedProgress.length > 0 && { removedProgress }),
    };
}
