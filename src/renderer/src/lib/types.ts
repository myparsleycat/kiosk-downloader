export type {
    Collection,
    CollectionTree,
    DirNode,
    DownloadFilter,
    DownloadItem,
    DownloadStatus,
    FileDownloadStatus,
    FileNode,
    FileProgress,
    TreeEntry,
    ZipEntryMeta,
    ZipNode,
} from "@shared/types";

import type { DirNode, FileNode, TreeEntry, ZipNode } from "@shared/types";
import { findZipNodeById, hasSelectedDescendant, isZipExtractMode } from "@shared/zip-tree";

function asDirEntries(node: DirNode | ZipNode): TreeEntry[] {
    if (node.type === "zip") {
        return node.entries ?? [];
    }
    return node.entries;
}

export function countFiles(dir: DirNode): number {
    let count = 0;
    function walk(node: DirNode | ZipNode) {
        for (const entry of asDirEntries(node)) {
            if (entry.kind === "file") {
                count += 1;
                continue;
            }
            if (entry.kind === "zip") {
                const zip = entry.node as ZipNode;
                if (zip.entries) {
                    walk(zip);
                } else {
                    count += 1;
                }
                continue;
            }
            walk(entry.node as DirNode);
        }
    }
    walk(dir);
    return count;
}

const dirTotalSizeCache = new WeakMap<DirNode, number>();

export function dirTotalSize(dir: DirNode | ZipNode): number {
    if (dir.type === "zip" && !dir.entries) {
        return dir.size;
    }

    if (dir.type === "dir") {
        const cached = dirTotalSizeCache.get(dir);
        if (cached !== undefined) {
            return cached;
        }
    }

    let total = 0;
    for (const entry of asDirEntries(dir)) {
        if (entry.kind === "file") {
            total += (entry.node as FileNode).size;
            continue;
        }
        if (entry.kind === "zip") {
            total += dirTotalSize(entry.node as ZipNode);
            continue;
        }
        total += dirTotalSize(entry.node as DirNode);
    }

    if (dir.type === "dir") {
        dirTotalSizeCache.set(dir, total);
    }
    return total;
}

export function collectAllPaths(root: DirNode): Set<string> {
    const paths = new Set<string>();

    function walk(node: DirNode | ZipNode, stack: string[]) {
        for (const entry of asDirEntries(node)) {
            const key = [...stack, entry.node.name].join("/");
            const childStack = [...stack, entry.node.name];
            if (entry.kind === "file") {
                paths.add(key);
                continue;
            }
            if (entry.kind === "zip") {
                const zip = entry.node as ZipNode;
                paths.add(key);
                if (zip.entries) {
                    walk(zip, childStack);
                }
                continue;
            }
            if (entry.node.name !== "") {
                paths.add(key);
            }
            walk(entry.node as DirNode, entry.node.name === "" ? stack : childStack);
        }
    }

    walk(root, []);
    return paths;
}

export function toggleTreeSelection(
    selected: Set<string>,
    key: string,
    root: DirNode,
): Set<string> {
    const resolved = resolveTreePath(root, key);
    if (!resolved) {
        return selected;
    }

    const next = new Set(selected);
    const selecting = !next.has(key);

    const subtreeRoot =
        resolved.kind === "dir"
            ? (resolved.node as DirNode)
            : resolved.kind === "zip" && (resolved.node as ZipNode).entries
              ? (resolved.node as ZipNode)
              : null;
    if (subtreeRoot) {
        const subtree = collectSubtreePaths(subtreeRoot, key);
        for (const path of subtree) {
            if (selecting) {
                next.add(path);
            } else {
                next.delete(path);
            }
        }
        if (selecting) {
            for (const parent of parentPaths(key)) {
                next.add(parent);
            }
        } else {
            pruneEmptyAncestors(key, next);
        }
        return next;
    }

    if (selecting) {
        next.add(key);
        for (const parent of parentPaths(key)) {
            next.add(parent);
        }
        return next;
    }

    next.delete(key);
    pruneEmptyAncestors(key, next);
    return next;
}

export function summarizeSelection(
    selected: Set<string>,
    root: DirNode,
): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;

    function walk(node: DirNode | ZipNode, stack: string[]) {
        for (const entry of asDirEntries(node)) {
            const child = entry.node;
            const key = [...stack, child.name].join("/");

            if (entry.kind === "file") {
                // Parent paths are ancestry markers only; folder select adds every descendant path.
                if (selected.has(key)) {
                    count += 1;
                    bytes += (child as FileNode).size;
                }
                continue;
            }

            if (entry.kind === "zip") {
                const zip = child as ZipNode;
                if (zip.entries) {
                    if (isZipExtractMode(key, selected)) {
                        walk(zip, [...stack, zip.name]);
                    } else if (selected.has(key)) {
                        count += 1;
                        bytes += zip.size;
                    }
                } else if (selected.has(key)) {
                    count += 1;
                    bytes += zip.size;
                }
                continue;
            }

            walk(child as DirNode, [...stack, child.name]);
        }
    }

    walk(root, []);
    return { count, bytes };
}

/** Checkbox state for dirs/zips: full subtree vs ancestry-marker-only partial selection. */
export function getSelectionCheckState(
    selected: Set<string>,
    key: string,
    node: DirNode | ZipNode,
): boolean | "indeterminate" {
    if (node.type === "zip" && !node.entries) {
        return selected.has(key);
    }

    const dirLike: DirNode | ZipNode =
        node.type === "zip"
            ? { type: "dir", id: node.id, name: node.name, entries: node.entries ?? [] }
            : node;
    const subtree = collectSubtreePaths(dirLike, key);
    if (subtree.every((path) => selected.has(path))) {
        return true;
    }
    if (hasSelectedDescendant(key, selected)) {
        return "indeterminate";
    }
    return false;
}

export function resolveTreePath(
    root: DirNode,
    key: string,
): { kind: "dir" | "file" | "zip"; node: DirNode | FileNode | ZipNode } | null {
    if (key === "") {
        return { kind: "dir", node: root };
    }

    const parts = key.split("/");
    let current: DirNode | ZipNode = root;

    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const isLast = index === parts.length - 1;
        const matched = asDirEntries(current).find((entry) => entry.node.name === part);

        if (!matched) {
            return null;
        }

        if (isLast) {
            return { kind: matched.kind, node: matched.node };
        }

        if (matched.kind === "dir") {
            current = matched.node as DirNode;
            continue;
        }

        if (matched.kind === "zip") {
            const zip = matched.node as ZipNode;
            if (!zip.entries) {
                return null;
            }
            current = zip;
            continue;
        }

        return null;
    }

    return null;
}

function collectSubtreePaths(dir: DirNode | ZipNode, dirKey: string): string[] {
    const paths = [dirKey];
    const stack = dirKey.split("/");

    function walk(node: DirNode | ZipNode, prefix: string[]) {
        for (const entry of asDirEntries(node)) {
            const child = entry.node;
            const childKey = [...prefix, child.name].join("/");
            paths.push(childKey);
            if (entry.kind === "file") {
                continue;
            }
            if (entry.kind === "zip") {
                const zip = child as ZipNode;
                if (zip.entries) {
                    walk(zip, [...prefix, zip.name]);
                }
                continue;
            }
            walk(child as DirNode, [...prefix, child.name]);
        }
    }

    walk(dir, stack);
    return paths;
}

export function parentPaths(key: string): string[] {
    const parts = key.split("/");
    const parents: string[] = [];
    for (let index = 1; index < parts.length; index += 1) {
        parents.push(parts.slice(0, index).join("/"));
    }
    return parents;
}

/**
 * A selected zip is stored as a marker path only; when its entries are loaded,
 * expand the marker into the full subtree so the zip stays selected in extract mode.
 */
export function selectExpandedZipEntries(
    selected: Set<string>,
    tree: DirNode,
    zipPath: string,
    fileId: string,
): Set<string> {
    if (!selected.has(zipPath)) {
        return selected;
    }
    const found = findZipNodeById(tree, fileId);
    if (!found?.zip.entries) {
        return selected;
    }
    return new Set([...selected, ...collectSubtreePaths(found.zip, zipPath)]);
}

function pruneEmptyAncestors(key: string, selected: Set<string>) {
    const parents = parentPaths(key);
    for (let index = parents.length - 1; index >= 0; index -= 1) {
        const parent = parents[index];
        if (!hasSelectedDescendant(parent, selected)) {
            selected.delete(parent);
        }
    }
}

export type SortField = "name" | "size";
export type SortDir = "none" | "desc" | "asc";

export function sortTree(root: DirNode, field: SortField, dir: SortDir): DirNode {
    if (dir === "none") return root;

    const sign = dir === "asc" ? 1 : -1;
    const compareName = (a: { name: string }, b: { name: string }) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * sign;

    const entrySize = (entry: TreeEntry): number => {
        if (entry.kind === "file") return (entry.node as FileNode).size;
        if (entry.kind === "zip") {
            const zip = entry.node as ZipNode;
            return zip.entries ? dirTotalSize(zip) : zip.size;
        }
        return dirTotalSize(entry.node as DirNode);
    };

    const sortNode = (node: DirNode): DirNode => {
        const dirs: TreeEntry[] = [];
        const zips: TreeEntry[] = [];
        const files: TreeEntry[] = [];
        for (const entry of node.entries) {
            if (entry.kind === "dir") dirs.push(entry);
            else if (entry.kind === "zip") zips.push(entry);
            else files.push(entry);
        }

        const compare =
            field === "name"
                ? (left: TreeEntry, right: TreeEntry) => compareName(left.node, right.node)
                : (left: TreeEntry, right: TreeEntry) =>
                      (entrySize(left) - entrySize(right)) * sign;
        dirs.sort(compare);
        zips.sort(compare);
        files.sort(compare);

        const entries = [
            ...dirs.map((e) => ({ kind: "dir" as const, node: sortNode(e.node as DirNode) })),
            ...zips.map((e) => {
                const zip = e.node as ZipNode;
                if (!zip.entries) {
                    return e;
                }
                return {
                    kind: "zip" as const,
                    node: {
                        ...zip,
                        entries: sortNode({
                            type: "dir",
                            id: zip.id,
                            name: zip.name,
                            entries: zip.entries,
                        }).entries,
                    },
                };
            }),
            ...files,
        ];

        const { type, id, name } = node;
        return { type, id, name, entries };
    };

    return sortNode(root);
}
