import type { DownloadItem, DownloadProgressPatch, FileProgress } from "@shared/types";
import { describe, expect, it } from "vitest";

import {
    applyPendingItems,
    mergeProgressPatch,
    mergeProgressPatchIntoItems,
} from "./merge-progress-patch";

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
const item = {
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
} satisfies DownloadItem;

describe("mergeProgressPatch", () => {
    it("변경된 파일만 교체하고 나머지 파일 참조를 보존한다", () => {
        const replacement = { ...changed, downloaded: 10, status: "completed" as const };
        const patch: DownloadProgressPatch = {
            id: item.id,
            progress: { "b.txt": replacement },
            summary: { transferredBytes: 10, totalBytes: 20, completedFiles: 1, totalFiles: 2 },
            status: "downloading",
            speedBps: 20,
            elapsedMs: 200,
            updatedAt: 2,
        };

        const result = mergeProgressPatch(item, patch);

        expect(result.progress["a.txt"]).toBe(unchanged);
        expect(result.progress["b.txt"]).toBe(replacement);
        expect(result.summary).toBe(patch.summary);
    });

    it("null 속도를 기존 item에서 제거한다", () => {
        const result = mergeProgressPatch(item, {
            id: item.id,
            progress: {},
            summary: item.summary,
            status: "paused",
            speedBps: null,
            elapsedMs: 300,
            updatedAt: 3,
        });

        expect(result.speedBps).toBeUndefined();
    });

    it("존재하지 않는 collection patch를 무시한다", () => {
        const items: DownloadItem[] = [item];
        const result = mergeProgressPatchIntoItems(items, {
            id: "missing",
            progress: {},
            summary: item.summary,
            status: "downloading",
            speedBps: 1,
            elapsedMs: 1,
            updatedAt: 2,
        });

        expect(result).toBe(items);
        expect(result[0]).toBe(item);
    });

    it("초기 목록 위에 collection별 마지막 full snapshot을 적용한다", () => {
        const replacement: DownloadItem = { ...item, status: "paused" };
        const added: DownloadItem = { ...item, id: "download-b" };

        const result = applyPendingItems(
            [item],
            new Map([
                [item.id, replacement],
                [added.id, added],
            ]),
        );

        expect(result).toEqual([added, replacement]);
    });

    it("변경된 파일만 교체하고 나머지 파일의 completedElsewhere를 보존한다", () => {
        const elsewhere: FileProgress = {
            ...unchanged,
            status: "completed",
            downloaded: 10,
            completedElsewhere: true,
        };
        const base = {
            ...item,
            progress: { "a.txt": elsewhere, "b.txt": changed },
        } satisfies DownloadItem;
        const replacement = { ...changed, downloaded: 10, status: "completed" as const };
        const patch: DownloadProgressPatch = {
            id: item.id,
            progress: { "b.txt": replacement },
            summary: { transferredBytes: 20, totalBytes: 20, completedFiles: 2, totalFiles: 2 },
            status: "downloading",
            speedBps: 20,
            elapsedMs: 200,
            updatedAt: 2,
        };

        const result = mergeProgressPatch(base, patch);

        expect(result.progress["a.txt"]).toBe(elsewhere);
        expect(result.progress["a.txt"].completedElsewhere).toBe(true);
        expect(result.progress["b.txt"]).toBe(replacement);
    });
});
