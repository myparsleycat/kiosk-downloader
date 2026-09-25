import type { DirNode, FileNode } from "@shared/types";

import { allocateUniqueName } from "./unique-name";

export function uniquifyWorkuploadTree(tree: DirNode, normalizeName: (name: string) => string) {
    const used = new Map<string, number>();
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
        return {
            kind: "file" as const,
            node: { ...file, name },
        };
    });

    return {
        tree: { ...tree, name: "", entries },
    };
}
