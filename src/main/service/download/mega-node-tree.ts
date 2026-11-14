import type { DirNode, FileNode, TreeEntry } from "@shared/types";

import { base64urlEncode, decryptNodeAttr } from "./transfer-it-crypto";

export type MegaNode = {
    h: string;
    p: string;
    t: number;
    a?: string;
    k?: string;
    s?: number;
};

type NamedNode = MegaNode & { name: string };

export type BuildMegaTreeOptions = {
    /** Returns the node's decrypted key (16 bytes for folders, 32 for files), or null when absent. */
    resolveNodeKey: (node: MegaNode) => Buffer | null;
    onNodeError: (nodeHandle: string, error: unknown) => void;
    /** Folder to use as the tree root. Without it the `p === ""` folder (or a synthesized root) is used. */
    rootHandle?: string;
    /** Keep only this file, placed directly under the root. */
    onlyFileHandle?: string;
    excludeHandle?: string;
};

/**
 * Builds the draft tree from MEGA `f` nodes. Names are sanitized and made unique per directory
 * because MEGA allows siblings with the same name, which would otherwise share one target path.
 */
export function buildMegaTree(nodes: MegaNode[], options: BuildMegaTreeOptions) {
    const byHandle = new Map<string, NamedNode>();
    const nodeKeys = new Map<string, string>();

    for (const node of nodes) {
        if (node.h === options.excludeHandle) {
            continue;
        }
        let name = "unknown";
        try {
            const keyBytes = options.resolveNodeKey(node);
            if (keyBytes) {
                const attr = node.a ? decryptNodeAttr(node.a, keyBytes) : null;
                if (attr?.n) {
                    name = sanitizeName(attr.n);
                }
                if (node.t === 0) {
                    if (keyBytes.length !== 32) {
                        throw new Error(`Invalid file key length for node ${node.h}.`);
                    }
                    nodeKeys.set(node.h, base64urlEncode(keyBytes));
                }
            }
        } catch (error) {
            options.onNodeError(node.h, error);
        }
        byHandle.set(node.h, { ...node, name });
    }

    const childrenOf = new Map<string, NamedNode[]>();
    for (const node of byHandle.values()) {
        const siblings = childrenOf.get(node.p);
        if (siblings) {
            siblings.push(node);
        } else {
            childrenOf.set(node.p, [node]);
        }
    }

    const toFile = (node: NamedNode, name: string): FileNode => ({
        type: "file",
        id: node.h,
        name,
        size: typeof node.s === "number" ? node.s : 0,
    });

    const buildEntries = (parent: string, visited: Set<string>): TreeEntry[] => {
        const used = new Set<string>();
        const entries: TreeEntry[] = [];
        for (const child of childrenOf.get(parent) ?? []) {
            if (child.t === 1 && !visited.has(child.h)) {
                const name = uniqueName(child.name, used, false);
                visited.add(child.h);
                entries.push({
                    kind: "dir",
                    node: {
                        type: "dir",
                        id: child.h,
                        name,
                        entries: buildEntries(child.h, visited),
                    },
                });
            } else if (child.t === 0) {
                entries.push({
                    kind: "file",
                    node: toFile(child, uniqueName(child.name, used, true)),
                });
            }
        }
        return entries;
    };

    if (options.onlyFileHandle) {
        const file = byHandle.get(options.onlyFileHandle);
        if (!file || file.t !== 0) {
            throw new Error("File not found in the shared folder.");
        }
        return {
            tree: {
                type: "dir" as const,
                id: "root",
                name: "",
                entries: [{ kind: "file" as const, node: toFile(file, file.name) }],
            },
            nodeKeys,
            rootName: file.name,
        };
    }

    const root = options.rootHandle
        ? byHandle.get(options.rootHandle)
        : [...byHandle.values()].find((node) => node.p === "" && node.t === 1);
    if (options.rootHandle && (!root || root.t !== 1)) {
        throw new Error("Folder not found in the shared folder.");
    }
    if (root) {
        // Virtual root name must be "" so FileTree / selection keys match kio.ac.
        return {
            tree: {
                type: "dir" as const,
                id: root.h,
                name: "",
                entries: buildEntries(root.h, new Set([root.h])),
            } satisfies DirNode,
            nodeKeys,
            rootName: root.name,
        };
    }

    // Flat listing with no explicit root folder: synthesize a root.
    return {
        tree: {
            type: "dir" as const,
            id: "root",
            name: "",
            entries: buildEntries("", new Set()),
        } satisfies DirNode,
        nodeKeys,
        rootName: "",
    };
}

/**
 * Mirrors the Windows-safe segment rules applied to download paths (invalid characters, outer
 * whitespace, trailing dots) so `uniqueName` sees the names that end up on disk.
 */
function sanitizeName(name: string) {
    return (
        name
            // oxlint-disable-next-line no-control-regex
            .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
            .replace(/[\s.]+$/, "")
            .trim() || "unknown"
    );
}

function uniqueName(name: string, used: Set<string>, isFile: boolean) {
    const dot = isFile ? name.lastIndexOf(".") : -1;
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let n = 1; used.has(candidate.toLowerCase()); n += 1) {
        candidate = `${stem} (${n})${ext}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}
