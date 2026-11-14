import type { DownloadItem, FileProgress, TransferItemChange } from "@shared/types";
import { describe, expect, it } from "vitest";

import { applyTransferItemChange, applyTransferItemChanges } from "./merge-progress-patch";

const unchanged: FileProgress = {
    fileId: "file-a",
    path: "a.txt",
    status: "pending",
    downloaded: 0,
    size: 10,
    selected: true,
};
const changed: FileProgress = {
    fileId: "file-b",
    path: "b.txt",
    status: "downloading",
    downloaded: 5,
    size: 10,
    selected: true,
};
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
    progress: { "a.txt": unchanged, "b.txt": changed },
    summary: { transferredBytes: 5, totalBytes: 20, completedFiles: 0, totalFiles: 2 },
    status: "downloading",
    speedBps: 10,
    elapsedMs: 100,
    createdAt: 1,
    updatedAt: 1,
};

describe("transfer item changes", () => {
    it("upsert로 기존 collection을 교체하고 새 collection을 추가한다", () => {
        const replacement: DownloadItem = { ...item, status: "paused" };
        const added: DownloadItem = { ...item, id: "download-b" };

        const replaced = applyTransferItemChange([item], {
            revision: 2,
            id: item.id,
            kind: "upsert",
            item: replacement,
        });
        const result = applyTransferItemChange(replaced, {
            revision: 3,
            id: added.id,
            kind: "upsert",
            item: added,
        });

        expect(result).toEqual([added, replacement]);
    });

    it("remove이면 collection을 삭제한다", () => {
        const result = applyTransferItemChange([item], {
            revision: 2,
            id: item.id,
            kind: "remove",
        });

        expect(result).toEqual([]);
    });

    it("patch는 바뀐 필드와 진행률만 교체하고 나머지 참조를 유지한다", () => {
        const progressed: FileProgress = { ...changed, downloaded: 8 };

        const [result] = applyTransferItemChange([item], {
            revision: 2,
            id: item.id,
            kind: "patch",
            patch: { fields: { speedBps: undefined }, progress: { "b.txt": progressed } },
        });

        expect(result.speedBps).toBeUndefined();
        expect(result.collection).toBe(item.collection);
        expect(result.progress["a.txt"]).toBe(unchanged);
        expect(result.progress["b.txt"]).toBe(progressed);
    });

    it("진행률 변경이 없는 patch는 progress 참조를 유지하고 removedProgress는 항목을 지운다", () => {
        const [fieldsOnly] = applyTransferItemChange([item], {
            revision: 2,
            id: item.id,
            kind: "patch",
            patch: { fields: { status: "paused" } },
        });
        const [removed] = applyTransferItemChange([item], {
            revision: 3,
            id: item.id,
            kind: "patch",
            patch: { fields: {}, removedProgress: ["b.txt"] },
        });

        expect(fieldsOnly.progress).toBe(item.progress);
        expect(Object.keys(removed.progress)).toEqual(["a.txt"]);
    });

    it("list revision보다 새 이벤트만 revision 순서로 적용한다", () => {
        const revisionFour = { ...item, status: "downloading" as const, updatedAt: 4 };
        const changes: TransferItemChange<DownloadItem>[] = [
            { revision: 4, id: item.id, kind: "upsert", item: revisionFour },
            { revision: 1, id: item.id, kind: "upsert", item: { ...item, updatedAt: 1 } },
            {
                revision: 3,
                id: item.id,
                kind: "patch",
                patch: { fields: { status: "paused", updatedAt: 3 } },
            },
        ];

        const result = applyTransferItemChanges({ revision: 2, items: [item] }, changes);

        expect(result).toEqual({ revision: 4, items: [revisionFour] });
    });

    it("같거나 오래된 revision과 tombstone 뒤의 뒤늦은 이벤트를 무시한다", () => {
        const result = applyTransferItemChanges({ revision: 2, items: [item] }, [
            { revision: 5, id: item.id, kind: "remove" },
            { revision: 4, id: item.id, kind: "upsert", item: { ...item, updatedAt: 4 } },
            { revision: 5, id: item.id, kind: "upsert", item: { ...item, updatedAt: 5 } },
        ]);

        expect(result).toEqual({ revision: 5, items: [] });
    });
});
