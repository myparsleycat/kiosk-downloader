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
} from "@shared/types";

import type { DirNode, FileNode, TreeEntry } from "@shared/types";

export function countFiles(dir: DirNode): number {
    let count = 0;
    for (const entry of dir.entries) {
        if (entry.kind === "file") count += 1;
        else count += countFiles(entry.node as DirNode);
    }
    return count;
}

export function dirTotalSize(dir: DirNode): number {
    let total = 0;
    for (const entry of dir.entries) {
        if (entry.kind === "file") total += (entry.node as FileNode).size;
        else total += dirTotalSize(entry.node as DirNode);
    }
    return total;
}

export function flattenTree(dir: DirNode, prefix: string[] = [], out: FlatFile[] = []): FlatFile[] {
    for (const entry of dir.entries) {
        if (entry.kind === "file") {
            const node = entry.node as FileNode;
            out.push({
                id: node.id,
                path: [...prefix, node.name].join("/"),
                name: node.name,
                size: node.size,
                dirName: prefix.join("/"),
            });
        } else {
            const child = entry.node as DirNode;
            flattenTree(child, [...prefix, child.name], out);
        }
    }
    return out;
}

export interface FlatFile {
    id: string;
    path: string;
    name: string;
    size: number;
    dirName: string;
}

export function collectAllPaths(root: DirNode): Set<string> {
    const paths = new Set<string>();

    function walk(dir: DirNode, stack: string[]) {
        for (const entry of dir.entries) {
            const node = entry.node as DirNode | FileNode;
            const key = [...stack, node.name].join("/");
            if (entry.kind === "file") {
                paths.add(key);
                continue;
            }
            if (node.name !== "") {
                paths.add(key);
            }
            walk(entry.node as DirNode, node.name === "" ? stack : [...stack, node.name]);
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

    if (resolved.kind === "dir") {
        const subtree = collectSubtreePaths(resolved.node as DirNode, key);
        if (selecting) {
            for (const path of subtree) {
                next.add(path);
            }
            for (const parent of parentPaths(key)) {
                next.add(parent);
            }
            return next;
        }

        for (const path of subtree) {
            next.delete(path);
        }
        for (const parent of parentPaths(key)) {
            if (!hasSelectedDescendant(parent, next)) {
                next.delete(parent);
            }
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
    for (const parent of parentPaths(key)) {
        if (!hasSelectedDescendant(parent, next)) {
            next.delete(parent);
        }
    }
    return next;
}

export function summarizeSelection(
    selected: Set<string>,
    root: DirNode,
): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;

    function walk(dir: DirNode, stack: string[], ancestorSelected: boolean) {
        for (const entry of dir.entries) {
            const node = entry.node as DirNode | FileNode;
            const key = [...stack, node.name].join("/");
            const selfSelected = selected.has(key);
            const effectivelySelected = ancestorSelected || selfSelected;

            if (entry.kind === "file") {
                if (effectivelySelected) {
                    count += 1;
                    bytes += (node as FileNode).size;
                }
            } else {
                walk(entry.node as DirNode, [...stack, node.name], effectivelySelected);
            }
        }
    }

    walk(root, [], false);
    return { count, bytes };
}

function resolveTreePath(
    root: DirNode,
    key: string,
): { kind: "dir" | "file"; node: DirNode | FileNode } | null {
    if (key === "") {
        return { kind: "dir", node: root };
    }

    const parts = key.split("/");
    let dir = root;

    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const isLast = index === parts.length - 1;
        const matched = dir.entries.find((entry) => entry.node.name === part);

        if (!matched) {
            return null;
        }

        if (isLast) {
            return { kind: matched.kind, node: matched.node };
        }

        if (matched.kind !== "dir") {
            return null;
        }

        dir = matched.node as DirNode;
    }

    return null;
}

function collectSubtreePaths(dir: DirNode, dirKey: string): string[] {
    const paths = [dirKey];
    const stack = dirKey.split("/");

    function walk(node: DirNode, prefix: string[]) {
        for (const entry of node.entries) {
            const child = entry.node as DirNode | FileNode;
            if (entry.kind === "file") {
                paths.push([...prefix, child.name].join("/"));
                continue;
            }
            const childDir = entry.node as DirNode;
            const childPrefix = childDir.name === "" ? prefix : [...prefix, childDir.name];
            if (childDir.name !== "") {
                paths.push(childPrefix.join("/"));
            }
            walk(childDir, childPrefix);
        }
    }

    walk(dir, stack);
    return paths;
}

function parentPaths(key: string): string[] {
    const parts = key.split("/");
    const parents: string[] = [];
    for (let index = 1; index < parts.length; index += 1) {
        parents.push(parts.slice(0, index).join("/"));
    }
    return parents;
}

function hasSelectedDescendant(dirKey: string, selected: Set<string>): boolean {
    const prefix = `${dirKey}/`;
    for (const path of selected) {
        if (path.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

export function treeEntries(dir: DirNode): TreeEntry[] {
    return dir.entries;
}

export type SortField = "name" | "size";
export type SortDir = "none" | "desc" | "asc";

// 디렉토리는 항상 파일 위에 그룹화하고, 각 그룹 내에서 선택한 필드/방향으로 정렬.
// dir === "none"이면 원본을 그대로 반환한다. 그 외에는 모든 중첩 디렉토리에 재귀 적용하며,
// DirNode만 얕게 복제(entries를 새 배열로 교체)하고 FileNode는 원본 참조를 재사용한다.
export function sortTree(root: DirNode, field: SortField, dir: SortDir): DirNode {
    if (dir === "none") return root;

    const sign = dir === "asc" ? 1 : -1;
    const compareName = (a: { name: string }, b: { name: string }) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * sign;

    const entrySize = (entry: TreeEntry): number =>
        entry.kind === "file" ? (entry.node as FileNode).size : dirTotalSize(entry.node as DirNode);

    const sortNode = (node: DirNode): DirNode => {
        const dirs: TreeEntry[] = [];
        const files: TreeEntry[] = [];
        for (const entry of node.entries) {
            if (entry.kind === "dir") dirs.push(entry);
            else files.push(entry);
        }

        if (field === "name") {
            dirs.sort((a, b) => compareName(a.node, b.node));
            files.sort((a, b) => compareName(a.node, b.node));
        } else {
            dirs.sort((a, b) => (entrySize(a) - entrySize(b)) * sign);
            files.sort((a, b) => (entrySize(a) - entrySize(b)) * sign);
        }

        const entries = [
            ...dirs.map((e) => ({ kind: "dir" as const, node: sortNode(e.node as DirNode) })),
            ...files,
        ];

        const { type, id, name } = node;
        return { type, id, name, entries };
    };

    return sortNode(root);
}
