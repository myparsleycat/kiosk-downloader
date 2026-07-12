import type { DirNode, FileNode, TreeEntry, ZipNode } from "./types";

export function buildDirTreeFromFiles(
    files: { path: string; name: string; size: number }[],
): DirNode {
    const root: DirNode = {
        type: "dir",
        id: "root",
        name: "",
        entries: [],
    };

    type MutableDir = DirNode;
    const dirsByPath = new Map<string, MutableDir>();
    dirsByPath.set("", root);

    const ensureDir = (segments: string[]): MutableDir => {
        const dirPath = segments.join("/");
        const existing = dirsByPath.get(dirPath);
        if (existing) {
            return existing;
        }

        const parent = ensureDir(segments.slice(0, -1));
        const dir: MutableDir = {
            type: "dir",
            id: dirPath,
            name: segments[segments.length - 1],
            entries: [],
        };
        dirsByPath.set(dirPath, dir);
        parent.entries.push({ kind: "dir", node: dir });
        return dir;
    };

    for (const file of files) {
        const segments = file.path.split("/").filter(Boolean);
        const dir = ensureDir(segments.slice(0, -1));
        const node: FileNode = {
            type: "file",
            id: file.path,
            name: segments[segments.length - 1] ?? file.name,
            size: file.size,
        };
        dir.entries.push({ kind: "file", node });
    }

    return root;
}

/**
 * Returns a new tree with node names replaced according to `renames`.
 *
 * Keys are tree paths built from the ORIGINAL names (e.g. "folder/file.txt").
 * Only the leaf segment of a matching path is renamed; descendants inherit the
 * new prefix automatically through the recursive pathStack. ZIP entry subtrees
 * (the inner files of a .zip) are left untouched because those names come from
 * the server-side archive structure and must not be altered by the client.
 *
 * The original `root` is never mutated; a fresh `DirNode` is returned.
 * When `renames` is empty the original `root` is returned as-is.
 */
export function applyRenames(root: DirNode, renames: Record<string, string>): DirNode {
    if (Object.keys(renames).length === 0) return root;
    return renameDir(root, [], renames);
}

function renameDir(dir: DirNode, prefix: string[], renames: Record<string, string>): DirNode {
    const entries: TreeEntry[] = [];
    for (const entry of dir.entries) {
        if (entry.kind === "file") {
            const node = entry.node as FileNode;
            const path = [...prefix, node.name].join("/");
            const renamed = renames[path];
            entries.push({
                kind: "file",
                node: renamed ? { ...node, name: renamed } : node,
            });
            continue;
        }
        if (entry.kind === "zip") {
            const zip = entry.node as ZipNode;
            const path = [...prefix, zip.name].join("/");
            const renamed = renames[path];
            entries.push({
                kind: "zip",
                node: renamed ? { ...zip, name: renamed } : zip,
            });
            continue;
        }
        const child = entry.node as DirNode;
        if (child.name === "") {
            entries.push({ kind: "dir", node: renameDir(child, prefix, renames) });
            continue;
        }
        const path = [...prefix, child.name].join("/");
        const renamed = renames[path];
        const newName = renamed ?? child.name;
        const renamedChild = renameDir(child, [...prefix, newName], renames);
        entries.push({
            kind: "dir",
            node: renamed ? { ...renamedChild, name: renamed } : renamedChild,
        });
    }
    return { ...dir, entries };
}
