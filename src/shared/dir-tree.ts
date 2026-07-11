import type { DirNode, FileNode } from "./types";

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
