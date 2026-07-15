import type { DirNode, FileNode, TreeEntry, UploadTreeFile, ZipNode } from "./types";

// oxlint-disable-next-line no-control-regex
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/;

export function parentPath(path: string) {
    const index = path.lastIndexOf("/");
    return index === -1 ? "" : path.slice(0, index);
}

export function joinPath(parent: string, name: string) {
    return parent ? `${parent}/${name}` : name;
}

export function basename(path: string) {
    const index = path.lastIndexOf("/");
    return index === -1 ? path : path.slice(index + 1);
}

export function validateNodeName(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        return "이름을 입력하세요.";
    }
    if (trimmed === "." || trimmed === "..") {
        return "사용할 수 없는 이름입니다.";
    }
    if (INVALID_NAME_CHARS.test(trimmed)) {
        return '이름에 \\ / : * ? " < > | 문자를 사용할 수 없습니다.';
    }
    return null;
}

export function toDisplayPath(originalPath: string, renames: Record<string, string>) {
    if (!originalPath) {
        return "";
    }
    const parts = originalPath.split("/").filter(Boolean);
    const display: string[] = [];
    let originalPrefix = "";
    for (const part of parts) {
        originalPrefix = originalPrefix ? `${originalPrefix}/${part}` : part;
        display.push(renames[originalPrefix] ?? part);
    }
    return display.join("/");
}

export function applyRenamesToTree(root: DirNode, renames: Record<string, string>): DirNode {
    if (Object.keys(renames).length === 0) {
        return root;
    }
    return mapDir(root, [], renames);
}

function mapDir(dir: DirNode, originalPrefix: string[], renames: Record<string, string>): DirNode {
    return {
        ...dir,
        entries: dir.entries.map((entry) => mapEntry(entry, originalPrefix, renames)),
    };
}

function mapEntry(
    entry: TreeEntry,
    originalPrefix: string[],
    renames: Record<string, string>,
): TreeEntry {
    const originalName = entry.node.name;
    const originalPath = [...originalPrefix, originalName].join("/");
    const newName = renames[originalPath] ?? originalName;

    if (entry.kind === "file") {
        const node = entry.node as FileNode;
        return {
            kind: "file",
            node: newName === node.name ? node : { ...node, name: newName },
        };
    }

    if (entry.kind === "zip") {
        const zip = entry.node as ZipNode;
        const entries = zip.entries
            ? mapDir(
                  { type: "dir", id: zip.id, name: "", entries: zip.entries },
                  [...originalPrefix, originalName],
                  renames,
              ).entries
            : null;
        if (newName === zip.name && entries === zip.entries) {
            return entry;
        }
        return {
            kind: "zip",
            node: {
                ...zip,
                name: newName,
                entries,
            },
        };
    }

    const child = entry.node as DirNode;
    const mapped = mapDir(child, [...originalPrefix, originalName], renames);
    if (newName === child.name && mapped === child) {
        return entry;
    }
    return {
        kind: "dir",
        node: {
            ...mapped,
            name: newName,
        },
    };
}

export function displayPathToOriginal(
    root: DirNode,
    renames: Record<string, string>,
    displayPath: string,
): string | null {
    if (!displayPath) {
        return "";
    }
    const displayParts = displayPath.split("/").filter(Boolean);
    let entries = root.entries;
    const originalParts: string[] = [];

    for (let index = 0; index < displayParts.length; index += 1) {
        const displayName = displayParts[index];
        let matched: TreeEntry | null = null;

        for (const entry of entries) {
            const originalName = entry.node.name;
            const originalPath = [...originalParts, originalName].join("/");
            const name = renames[originalPath] ?? originalName;
            if (name === displayName) {
                matched = entry;
                originalParts.push(originalName);
                break;
            }
        }

        if (!matched) {
            return null;
        }

        if (index === displayParts.length - 1) {
            return originalParts.join("/");
        }

        if (matched.kind === "dir") {
            entries = (matched.node as DirNode).entries;
            continue;
        }

        if (matched.kind === "zip") {
            const zip = matched.node as ZipNode;
            if (!zip.entries) {
                return null;
            }
            entries = zip.entries;
            continue;
        }

        return null;
    }

    return originalParts.join("/");
}

export function hasSiblingNameConflict(
    root: DirNode,
    parentPathValue: string,
    newName: string,
    excludePath: string,
): boolean {
    const parent = parentPathValue === "" ? root : findDirLike(root, parentPathValue);
    if (!parent) {
        return false;
    }
    const lower = newName.toLowerCase();
    return parent.entries.some((entry) => {
        const path = joinPath(parentPathValue, entry.node.name);
        if (path === excludePath) {
            return false;
        }
        return entry.node.name.toLowerCase() === lower;
    });
}

function findDirLike(root: DirNode, path: string): DirNode | null {
    const parts = path.split("/").filter(Boolean);
    let current: DirNode = root;

    for (const part of parts) {
        const entry = current.entries.find((item) => item.node.name === part);
        if (!entry) {
            return null;
        }
        if (entry.kind === "dir") {
            current = entry.node as DirNode;
            continue;
        }
        if (entry.kind === "zip") {
            const zip = entry.node as ZipNode;
            if (!zip.entries) {
                return null;
            }
            current = { type: "dir", id: zip.id, name: zip.name, entries: zip.entries };
            continue;
        }
        return null;
    }

    return current;
}

export function rewritePathKey(key: string, fromPath: string, toPath: string) {
    if (key === fromPath) {
        return toPath;
    }
    const prefix = `${fromPath}/`;
    if (key.startsWith(prefix)) {
        return `${toPath}/${key.slice(prefix.length)}`;
    }
    return key;
}

export function rewritePathKeys(keys: Iterable<string>, fromPath: string, toPath: string) {
    return [...keys].map((key) => rewritePathKey(key, fromPath, toPath));
}

export function rewritePathSet(keys: Set<string>, fromPath: string, toPath: string) {
    return new Set(rewritePathKeys(keys, fromPath, toPath));
}

export function renameUploadFiles<T extends UploadTreeFile>(
    files: T[],
    targetPath: string,
    newName: string,
): T[] {
    const toPath = joinPath(parentPath(targetPath), newName);
    if (toPath === targetPath) {
        return files;
    }

    const prefix = `${targetPath}/`;
    return files.map((file) => {
        if (file.path === targetPath) {
            return {
                ...file,
                path: toPath,
                name: newName,
            };
        }
        if (file.path.startsWith(prefix)) {
            const nextPath = `${toPath}/${file.path.slice(prefix.length)}`;
            return {
                ...file,
                path: nextPath,
                name: basename(nextPath),
            };
        }
        return file;
    });
}

export function hasUploadPathConflict(
    files: { path: string }[],
    targetPath: string,
    newName: string,
) {
    const toPath = joinPath(parentPath(targetPath), newName);
    if (toPath === targetPath) {
        return false;
    }
    const prefix = `${targetPath}/`;
    const nextPaths = new Set(
        files.map((file) => {
            if (file.path === targetPath) {
                return toPath;
            }
            if (file.path.startsWith(prefix)) {
                return `${toPath}/${file.path.slice(prefix.length)}`;
            }
            return file.path;
        }),
    );
    return nextPaths.size !== files.length;
}
