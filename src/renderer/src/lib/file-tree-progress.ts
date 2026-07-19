import type { DirNode, FileProgress, TreeEntry, ZipNode } from "@shared/types";

export interface FileTreeError {
    path: string;
    message: string;
}

export interface DirProgressSummary {
    totalSize: number;
    folderTotalSize: number;
    downloaded: number;
    speedBps: number;
    fileCount: number;
    excludedCount: number;
    selectedCount: number;
    completedCount: number;
    allExcluded: boolean;
    hasDownloading: boolean;
    hasInflating: boolean;
    hasPaused: boolean;
    hasError: boolean;
    errors: FileTreeError[];
    status: "skipped" | "completed" | "downloading" | "inflating" | "error" | "paused" | "pending";
}

type DirProgressAccumulator = Omit<DirProgressSummary, "allExcluded" | "status">;

export function buildDirProgressSummaries(root: DirNode, progress: Record<string, FileProgress>) {
    const summaries = new Map<string, DirProgressSummary>();

    function walk(dir: DirNode, pathStack: string[]): DirProgressSummary {
        const accumulated = emptySummary();

        for (const entry of dir.entries) {
            if (
                entry.kind === "file" ||
                (entry.kind === "zip" && !(entry.node as ZipNode).entries)
            ) {
                addFileProgress(accumulated, entry, pathStack, progress);
                continue;
            }

            const node = entry.node as DirNode | ZipNode;
            const childStack =
                entry.kind === "dir" && node.name === "" ? pathStack : [...pathStack, node.name];
            mergeSummary(
                accumulated,
                walk(
                    entry.kind === "zip"
                        ? {
                              type: "dir",
                              id: node.id,
                              name: node.name,
                              entries: (node as ZipNode).entries ?? [],
                          }
                        : (node as DirNode),
                    childStack,
                ),
            );
        }

        const summary = finalizeSummary(accumulated);
        summaries.set(pathStack.join("/"), summary);
        return summary;
    }

    walk(root, []);
    return summaries;
}

function emptySummary(): DirProgressAccumulator {
    return {
        totalSize: 0,
        folderTotalSize: 0,
        downloaded: 0,
        speedBps: 0,
        fileCount: 0,
        excludedCount: 0,
        selectedCount: 0,
        completedCount: 0,
        hasDownloading: false,
        hasInflating: false,
        hasPaused: false,
        hasError: false,
        errors: [],
    };
}

function addFileProgress(
    summary: DirProgressAccumulator,
    entry: TreeEntry,
    pathStack: string[],
    progress: Record<string, FileProgress>,
) {
    const node = entry.node as { name: string; size: number };
    const key = [...pathStack, node.name].join("/");
    const fileProgress = progress[key];

    summary.fileCount += 1;
    summary.folderTotalSize += node.size;
    if (fileProgress?.selected === false) {
        summary.excludedCount += 1;
        return;
    }

    summary.selectedCount += 1;
    summary.totalSize += node.size;
    summary.downloaded += fileProgress?.downloaded ?? 0;

    const status = fileProgress?.status ?? "pending";
    if (status === "downloading") {
        summary.hasDownloading = true;
        summary.speedBps += fileProgress?.speedBps ?? 0;
        return;
    }
    if (status === "inflating") {
        summary.hasInflating = true;
        return;
    }
    if (status === "paused") {
        summary.hasPaused = true;
        return;
    }
    if (status === "error") {
        summary.hasError = true;
        summary.errors.push({ path: key, message: fileProgress?.error ?? "오류 정보가 없습니다." });
        return;
    }
    if (status === "completed") {
        summary.completedCount += 1;
    }
}

function mergeSummary(summary: DirProgressAccumulator, child: DirProgressSummary) {
    summary.totalSize += child.totalSize;
    summary.folderTotalSize += child.folderTotalSize;
    summary.downloaded += child.downloaded;
    summary.speedBps += child.speedBps;
    summary.fileCount += child.fileCount;
    summary.excludedCount += child.excludedCount;
    summary.selectedCount += child.selectedCount;
    summary.completedCount += child.completedCount;
    summary.hasDownloading ||= child.hasDownloading;
    summary.hasInflating ||= child.hasInflating;
    summary.hasPaused ||= child.hasPaused;
    summary.hasError ||= child.hasError;
    summary.errors.push(...child.errors);
}

function finalizeSummary(summary: DirProgressAccumulator): DirProgressSummary {
    const allExcluded = summary.fileCount > 0 && summary.excludedCount === summary.fileCount;
    return {
        ...summary,
        allExcluded,
        status: dirProgressStatus(allExcluded, summary),
    };
}

function dirProgressStatus(
    allExcluded: boolean,
    summary: DirProgressAccumulator,
): DirProgressSummary["status"] {
    if (allExcluded) return "skipped";
    if (summary.selectedCount > 0 && summary.completedCount === summary.selectedCount) {
        return "completed";
    }
    if (summary.hasDownloading) return "downloading";
    if (summary.hasInflating) return "inflating";
    if (summary.hasError) return "error";
    if (summary.hasPaused) return "paused";
    return "pending";
}
