import path from "node:path";

import type { DirNode, FileNode } from "@shared/types";

export function uniquifyWorkuploadTree(tree: DirNode, normalizeName: (name: string) => string) {
    const used = new Set<string>();
    const pathMap = new Map<string, string>();
    const files = tree.entries.map((entry) => {
        if (entry.kind !== "file") {
            throw new Error("Workupload collections must contain only flat files.");
        }

        const file = entry.node as FileNode;
        return { file, normalized: normalizeName(file.name) || "Untitled" };
    });
    const namesById = new Map(
        files.map(({ file, normalized }) => [file.id, allocateUniqueName(normalized, used)]),
    );
    const entries = files.map(({ file }) => {
        const name = namesById.get(file.id)!;
        pathMap.set(file.name, name);
        return {
            kind: "file" as const,
            node: { ...file, name },
        };
    });

    return {
        tree: { ...tree, name: "", entries },
        pathMap,
    };
}

function allocateUniqueName(name: string, used: Set<string>) {
    if (!used.has(name.toLowerCase())) {
        used.add(name.toLowerCase());
        return name;
    }

    const extension = path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${stem} (${suffix})${extension}`;
        const key = candidate.toLowerCase();
        if (!used.has(key)) {
            used.add(key);
            return candidate;
        }
    }
}
