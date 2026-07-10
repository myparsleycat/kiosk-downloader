import type { DirNode, FileNode, TreeEntry, ZipEntryMeta, ZipNode } from "./types";

import { normalizePath } from "./utils";

export function isZipFileName(name: string) {
    return name.toLowerCase().endsWith(".zip");
}

export function isZipNode(node: DirNode | FileNode | ZipNode): node is ZipNode {
    return node.type === "zip";
}

export function isDirLike(entry: TreeEntry): entry is TreeEntry & { kind: "dir" | "zip" } {
    return entry.kind === "dir" || entry.kind === "zip";
}

export type IndexedZipEntry = ZipEntryMeta & {
    name: string;
    directory: boolean;
};

export function buildZipEntriesTree(zipRemoteId: string, indexed: IndexedZipEntry[]): TreeEntry[] {
    const root: DirNode = {
        type: "dir",
        id: `${zipRemoteId}:root`,
        name: "",
        entries: [],
    };

    type MutableDir = DirNode;
    const ensureDir = (parent: MutableDir, parts: string[], depth: number): MutableDir => {
        if (depth >= parts.length) {
            return parent;
        }
        const name = parts[depth];
        const existing = parent.entries.find(
            (entry) => entry.kind === "dir" && entry.node.name === name,
        );
        if (existing) {
            return ensureDir(existing.node as MutableDir, parts, depth + 1);
        }
        const dir: MutableDir = {
            type: "dir",
            id: `${zipRemoteId}:dir:${parts.slice(0, depth + 1).join("/")}`,
            name,
            entries: [],
        };
        parent.entries.push({ kind: "dir", node: dir });
        return ensureDir(dir, parts, depth + 1);
    };

    for (const entry of indexed) {
        const normalized = normalizePath(entry.path.replace(/\\/g, "/")).replace(/\/+$/, "");
        if (!normalized || normalized.includes("..")) {
            continue;
        }
        const parts = normalized.split("/").filter(Boolean);
        if (parts.length === 0) {
            continue;
        }
        if (entry.directory) {
            ensureDir(root, parts, 0);
            continue;
        }
        const fileName = parts[parts.length - 1];
        const parent = ensureDir(root, parts.slice(0, -1), 0);
        const file: FileNode = {
            type: "file",
            id: `${zipRemoteId}:entry:${normalized}`,
            name: fileName,
            size: entry.uncompressedSize,
            zipEntry: {
                path: normalized,
                offset: entry.offset,
                compressedSize: entry.compressedSize,
                uncompressedSize: entry.uncompressedSize,
                compressionMethod: entry.compressionMethod,
                encrypted: entry.encrypted,
            },
        };
        parent.entries.push({ kind: "file", node: file });
    }

    return root.entries;
}

export function findZipNodeById(
    root: DirNode,
    fileId: string,
): { zip: ZipNode; path: string } | null {
    let found: { zip: ZipNode; path: string } | null = null;

    function walk(dir: DirNode, stack: string[]) {
        if (found) {
            return;
        }
        for (const entry of dir.entries) {
            if (entry.kind === "zip") {
                const zip = entry.node as ZipNode;
                const path = [...stack, zip.name].join("/");
                if (zip.id === fileId) {
                    found = { zip, path };
                    return;
                }
                if (zip.entries) {
                    walk({ type: "dir", id: zip.id, name: zip.name, entries: zip.entries }, [
                        ...stack,
                        zip.name,
                    ]);
                }
                continue;
            }
            if (entry.kind === "dir") {
                const child = entry.node as DirNode;
                walk(child, child.name === "" ? stack : [...stack, child.name]);
            }
        }
    }

    walk(root, []);
    return found;
}

export function listZipNodes(root: DirNode): { zip: ZipNode; path: string }[] {
    const out: { zip: ZipNode; path: string }[] = [];

    function walk(dir: DirNode, stack: string[]) {
        for (const entry of dir.entries) {
            if (entry.kind === "zip") {
                const zip = entry.node as ZipNode;
                const path = [...stack, zip.name].join("/");
                out.push({ zip, path });
                if (zip.entries) {
                    walk({ type: "dir", id: zip.id, name: zip.name, entries: zip.entries }, [
                        ...stack,
                        zip.name,
                    ]);
                }
                continue;
            }
            if (entry.kind === "dir") {
                const child = entry.node as DirNode;
                walk(child, child.name === "" ? stack : [...stack, child.name]);
            }
        }
    }

    walk(root, []);
    return out;
}

export function setZipEntries(root: DirNode, fileId: string, entries: TreeEntry[]): DirNode {
    const cloneDir = (dir: DirNode): DirNode => ({
        type: "dir",
        id: dir.id,
        name: dir.name,
        entries: dir.entries.map((entry) => {
            if (entry.kind === "file") {
                return entry;
            }
            if (entry.kind === "zip") {
                const zip = entry.node as ZipNode;
                if (zip.id === fileId) {
                    return {
                        kind: "zip" as const,
                        node: { ...zip, entries },
                    };
                }
                if (!zip.entries) {
                    return entry;
                }
                return {
                    kind: "zip" as const,
                    node: {
                        ...zip,
                        entries: cloneDir({
                            type: "dir",
                            id: zip.id,
                            name: zip.name,
                            entries: zip.entries,
                        }).entries,
                    },
                };
            }
            return {
                kind: "dir" as const,
                node: cloneDir(entry.node as DirNode),
            };
        }),
    });

    return cloneDir(root);
}

export function hasSelectedDescendant(dirKey: string, selected: Set<string> | Iterable<string>) {
    const prefix = `${normalizePath(dirKey)}/`;
    for (const path of selected) {
        if (normalizePath(path).startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

export function isZipExtractMode(zipPath: string, selectedPaths: Set<string> | Iterable<string>) {
    return hasSelectedDescendant(zipPath, selectedPaths);
}

export function isPathSelected(filePath: string, selectedPaths: Set<string>) {
    if (selectedPaths.size === 0) {
        return true;
    }
    // Parent paths are ancestry markers only; full folder select stores every descendant path.
    return selectedPaths.has(normalizePath(filePath));
}
