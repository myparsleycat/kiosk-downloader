import type { DownloadItem, TransferItemChange } from "@shared/types";
import { describe, expect, it } from "vitest";

import { applyTransferItemChanges } from "../../renderer/src/lib/merge-progress-patch";
import { TransferItemPublisher } from "./transfer-item-publisher";

const item: DownloadItem = {
    id: "download-a",
    collection: {
        shareId: "share-a",
        name: "Download",
        expires: 1,
        segmentSize: 10,
        passwordProtected: false,
        tree: { type: "dir", id: "root", name: "", entries: [] },
    },
    savePath: "/tmp",
    progress: {
        "a.txt": {
            fileId: "file-a",
            path: "a.txt",
            status: "downloading",
            downloaded: 1,
            size: 10,
            selected: true,
            speedBps: 5,
        },
        "b.txt": {
            fileId: "file-b",
            path: "b.txt",
            status: "pending",
            downloaded: 0,
            size: 10,
            selected: true,
        },
    },
    summary: { transferredBytes: 1, totalBytes: 20, completedFiles: 0, totalFiles: 2 },
    status: "downloading",
    speedBps: 5,
    elapsedMs: 100,
    createdAt: 1,
    updatedAt: 1,
};

function createPublisher() {
    const changes: TransferItemChange<DownloadItem>[] = [];
    const delivery = { ok: true };
    const publisher = new TransferItemPublisher<DownloadItem>((change) => {
        if (delivery.ok) changes.push(change);
        return delivery.ok;
    });
    return { publisher, changes, delivery };
}

describe("TransferItemPublisher", () => {
    it("처음에는 upsert, 이후에는 바뀐 필드와 진행률만 patch로 보내고 같은 상태는 보내지 않는다", () => {
        const { publisher, changes } = createPublisher();
        const { speedBps: _speedBps, ...withoutSpeed } = item;
        const next: DownloadItem = {
            ...withoutSpeed,
            collection: { ...item.collection },
            progress: {
                ...item.progress,
                "a.txt": { ...item.progress["a.txt"], downloaded: 4 },
            },
        };

        publisher.publish(item);
        publisher.publish(next);
        publisher.publish({ ...next });

        expect(changes).toEqual([
            { revision: 1, id: item.id, kind: "upsert", item },
            {
                revision: 2,
                id: item.id,
                kind: "patch",
                patch: {
                    fields: { speedBps: undefined },
                    progress: { "a.txt": next.progress["a.txt"] },
                },
            },
        ]);
        // toEqual ignores undefined-valued keys; the renderer relies on the key being present.
        const patch = changes[1];
        expect(patch.kind === "patch" && Object.hasOwn(patch.patch.fields, "speedBps")).toBe(true);
    });

    it("전달되지 못한 변경은 다음 patch에 다시 실린다", () => {
        const { publisher, changes, delivery } = createPublisher();
        publisher.publish(item);
        delivery.ok = false;
        publisher.publish({ ...item, status: "paused" });
        delivery.ok = true;
        publisher.publish({ ...item, status: "paused", elapsedMs: 200 });

        expect(changes.at(-1)).toMatchObject({
            kind: "patch",
            patch: { fields: { status: "paused", elapsedMs: 200 } },
        });
    });

    it("snapshot 이후의 patch를 snapshot에 적용하면 최신 항목과 같아진다", () => {
        const { publisher, changes } = createPublisher();
        publisher.publish(item);
        publisher.publish({ ...item, id: "download-gone" });
        publisher.publish({ ...item, status: "paused", speedBps: undefined });

        const snapshot = publisher.snapshot([item]);
        // Same status as the pre-snapshot baseline: only a snapshot-synced baseline emits it.
        const latest: DownloadItem = {
            ...item,
            status: "paused",
            progress: { "a.txt": { ...item.progress["a.txt"], status: "completed" } },
        };
        publisher.publish(latest);

        const result = applyTransferItemChanges(snapshot, changes);
        expect(result.items).toEqual([latest]);
        expect(changes.at(-1)).toMatchObject({
            kind: "patch",
            patch: { removedProgress: ["b.txt"] },
        });
        expect(
            changes.some((change) => change.id === "download-gone" && change.kind === "remove"),
        ).toBe(true);
    });
});
