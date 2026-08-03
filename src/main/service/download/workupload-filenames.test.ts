import type { DirNode } from "@shared/types";
import { describe, expect, it } from "vitest";

import { uniquifyWorkuploadTree } from "./workupload-filenames";

describe("uniquifyWorkuploadTree", () => {
    it("deduplicates normalized names case-insensitively while preserving extensions", () => {
        const result = uniquifyWorkuploadTree(
            tree(["photo.jpg", "PHOTO.JPG", "photo (2).jpg", "a:b.txt", "a?b.txt"]),
            (name) => name.replace(/[:?]/g, "_"),
        );

        expect(result.tree.entries.map((entry) => entry.node.name)).toEqual([
            "photo.jpg",
            "PHOTO (2).JPG",
            "photo (2) (2).jpg",
            "a_b.txt",
            "a_b (2).txt",
        ]);
    });

    it("returns the final display-path mapping and rejects nested nodes", () => {
        const result = uniquifyWorkuploadTree(tree(["한글.txt"]), () => "hangul.txt");
        expect(result.pathMap.get("한글.txt")).toBe("hangul.txt");

        expect(() =>
            uniquifyWorkuploadTree(
                {
                    ...tree([]),
                    entries: [{ kind: "dir", node: tree(["nested.txt"]) }],
                },
                (name) => name,
            ),
        ).toThrow("flat files");
    });

    it("assigns collisions in manifest order and stays stable for repeated manifests", () => {
        const first = tree(["a:b.txt", "a?b.txt"]);
        first.entries[0]!.node.id = "z-key";
        first.entries[1]!.node.id = "a-key";
        const normalize = (name: string) => name.replace(/[:?]/g, "_");
        const toNames = (value: DirNode) =>
            new Map(
                uniquifyWorkuploadTree(value, normalize).tree.entries.map((entry) => [
                    entry.node.id,
                    entry.node.name,
                ]),
            );

        expect(toNames(first)).toEqual(
            new Map([
                ["z-key", "a_b.txt"],
                ["a-key", "a_b (2).txt"],
            ]),
        );
        expect(toNames(treeWithIds(["z-key", "a-key"]))).toEqual(toNames(first));
        expect(toNames(treeWithIds(["a-key", "z-key"]))).toEqual(
            new Map([
                ["a-key", "a_b.txt"],
                ["z-key", "a_b (2).txt"],
            ]),
        );
    });
});

function tree(names: string[]): DirNode {
    return {
        type: "dir",
        id: "root",
        name: "",
        entries: names.map((name, index) => ({
            kind: "file",
            node: { type: "file", id: `file-${index}`, name, size: index + 1 },
        })),
    };
}

function treeWithIds(ids: string[]) {
    const value = tree(["a:b.txt", "a?b.txt"]);
    value.entries.forEach((entry, index) => {
        entry.node.id = ids[index]!;
    });
    return value;
}
