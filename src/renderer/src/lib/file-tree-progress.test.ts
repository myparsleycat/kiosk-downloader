import type { DirNode, FileProgress } from "@shared/types";
import { describe, expect, it } from "vitest";

import { buildDirProgressSummaries } from "./file-tree-progress";

function fileProgress(
    path: string,
    status: FileProgress["status"],
    downloaded: number,
    options: Partial<FileProgress> = {},
): FileProgress {
    return {
        fileId: path,
        path,
        status,
        downloaded,
        size: options.size ?? downloaded,
        selected: true,
        ...options,
    };
}

const root: DirNode = {
    type: "dir",
    id: "root",
    name: "",
    entries: [
        { kind: "file", node: { type: "file", id: "a", name: "a.bin", size: 100 } },
        {
            kind: "zip",
            node: { type: "zip", id: "closed", name: "closed.zip", size: 500, entries: null },
        },
        {
            kind: "dir",
            node: {
                type: "dir",
                id: "folder",
                name: "folder",
                entries: [
                    { kind: "file", node: { type: "file", id: "b", name: "b.bin", size: 200 } },
                ],
            },
        },
        {
            kind: "zip",
            node: {
                type: "zip",
                id: "open",
                name: "open.zip",
                size: 700,
                entries: [
                    { kind: "file", node: { type: "file", id: "c", name: "c.bin", size: 300 } },
                ],
            },
        },
    ],
};

describe("buildDirProgressSummaries", () => {
    it("aggregates regular files, unopened zips, directories, and opened zips", () => {
        const summaries = buildDirProgressSummaries(root, {
            "a.bin": fileProgress("a.bin", "downloading", 40, { size: 100, speedBps: 25 }),
            "closed.zip": fileProgress("closed.zip", "pending", 0, {
                size: 500,
                selected: false,
            }),
            "folder/b.bin": fileProgress("folder/b.bin", "completed", 200, { size: 200 }),
            "open.zip/c.bin": fileProgress("open.zip/c.bin", "error", 10, {
                size: 300,
                error: "broken",
            }),
        });

        expect(summaries.get("folder")).toMatchObject({
            totalSize: 200,
            folderTotalSize: 200,
            completedCount: 1,
            status: "completed",
        });
        expect(summaries.get("open.zip")).toMatchObject({
            totalSize: 300,
            downloaded: 10,
            hasError: true,
            status: "error",
        });
        expect(summaries.get("")).toMatchObject({
            totalSize: 600,
            folderTotalSize: 1100,
            downloaded: 250,
            speedBps: 25,
            fileCount: 4,
            excludedCount: 1,
            selectedCount: 3,
            completedCount: 1,
            status: "downloading",
        });
        expect(summaries.get("")?.errors).toEqual([{ path: "open.zip/c.bin", message: "broken" }]);
    });

    it("marks a directory skipped when every file-like entry is excluded", () => {
        const summaries = buildDirProgressSummaries(root, {
            "a.bin": fileProgress("a.bin", "pending", 0, { selected: false }),
            "closed.zip": fileProgress("closed.zip", "pending", 0, { selected: false }),
            "folder/b.bin": fileProgress("folder/b.bin", "pending", 0, { selected: false }),
            "open.zip/c.bin": fileProgress("open.zip/c.bin", "pending", 0, { selected: false }),
        });

        expect(summaries.get("")).toMatchObject({
            allExcluded: true,
            fileCount: 4,
            excludedCount: 4,
            totalSize: 0,
            folderTotalSize: 1100,
            status: "skipped",
        });
    });
});
