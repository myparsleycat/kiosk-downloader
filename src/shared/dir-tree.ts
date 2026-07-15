import type { DirNode, FileNode } from "./types";

export function buildDirTreeFromFiles(
    files: { path: string; name: string; size: number }[],
): DirNode {
    const normalizedPaths = validateDirTreeFilePaths(files);
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

    for (const [index, file] of files.entries()) {
        const normalizedPath = normalizedPaths[index];
        const segments = normalizedPath.split("/");
        const dir = ensureDir(segments.slice(0, -1));
        const node: FileNode = {
            type: "file",
            id: normalizedPath,
            name: segments[segments.length - 1] ?? file.name,
            size: file.size,
        };
        dir.entries.push({ kind: "file", node });
    }

    return root;
}

export function validateDirTreeFilePaths(files: { path: string }[]) {
    const filePaths = new Set<string>();
    const directoryPaths = new Set<string>();

    return files.map((file) => {
        const normalizedPath = file.path.split("/").filter(Boolean).join("/");
        if (
            !normalizedPath ||
            filePaths.has(normalizedPath) ||
            directoryPaths.has(normalizedPath)
        ) {
            throw new Error(`업로드 경로가 비어 있거나 중복됩니다: ${file.path}`);
        }

        const segments = normalizedPath.split("/");
        for (let index = 1; index < segments.length; index += 1) {
            const directoryPath = segments.slice(0, index).join("/");
            if (filePaths.has(directoryPath)) {
                throw new Error(`업로드 파일과 폴더 경로가 충돌합니다: ${file.path}`);
            }
            directoryPaths.add(directoryPath);
        }

        filePaths.add(normalizedPath);
        return normalizedPath;
    });
}
