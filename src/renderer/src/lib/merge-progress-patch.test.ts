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
    it("full item snapshot으로 기존 collection을 교체하고 새 collection을 추가한다", () => {
        const replacement: DownloadItem = { ...item, status: "paused" };
        const added: DownloadItem = { ...item, id: "download-b" };

        const replaced = applyTransferItemChange([item], {
            revision: 2,
            id: item.id,
            item: replacement,
        });
        const result = applyTransferItemChange(replaced, {
            revision: 3,
            id: added.id,
            item: added,
        });

        expect(result).toEqual([added, replacement]);
    });

    it("item이 null이면 collection을 삭제한다", () => {
        const result = applyTransferItemChange([item], {
            revision: 2,
            id: item.id,
            item: null,
        });

        expect(result).toEqual([]);
    });

    it("list revision보다 새 이벤트만 revision 순서로 적용한다", () => {
        const revisionThree = { ...item, status: "paused" as const, updatedAt: 3 };
        const revisionFour = { ...item, status: "downloading" as const, updatedAt: 4 };
        const changes: TransferItemChange<DownloadItem>[] = [
            { revision: 4, id: item.id, item: revisionFour },
            { revision: 1, id: item.id, item: { ...item, updatedAt: 1 } },
            { revision: 3, id: item.id, item: revisionThree },
        ];

        const result = applyTransferItemChanges({ revision: 2, items: [item] }, changes);

        expect(result).toEqual({ revision: 4, items: [revisionFour] });
    });

    it("같거나 오래된 revision과 tombstone 뒤의 뒤늦은 이벤트를 무시한다", () => {
        const result = applyTransferItemChanges({ revision: 2, items: [item] }, [
            { revision: 5, id: item.id, item: null },
            { revision: 4, id: item.id, item: { ...item, updatedAt: 4 } },
            { revision: 5, id: item.id, item: { ...item, updatedAt: 5 } },
        ]);

        expect(result).toEqual({ revision: 5, items: [] });
    });
});
