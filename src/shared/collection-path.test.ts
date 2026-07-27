import { describe, expect, it } from "vitest";

import type { CollectionTree } from "./types";

import { hasRedundantCollectionRootDir, shouldCreateCollectionSubfolder } from "./collection-path";

function dirTree(name: string): CollectionTree {
    return {
        type: "dir",
        id: "root",
        name: "",
        entries: [{ kind: "dir", node: { type: "dir", id: "d1", name, entries: [] } }],
    };
}

describe("hasRedundantCollectionRootDir", () => {
    it("returns true when the single root dir matches the collection name", () => {
        expect(hasRedundantCollectionRootDir(dirTree("Photos"), "Photos")).toBe(true);
    });

    it("matches case-insensitively", () => {
        expect(hasRedundantCollectionRootDir(dirTree("photos"), "Photos")).toBe(true);
        expect(hasRedundantCollectionRootDir(dirTree("PHOTOS"), "Photos")).toBe(true);
    });

    it("returns false when the single root dir has a different name", () => {
        expect(hasRedundantCollectionRootDir(dirTree("Images"), "Photos")).toBe(false);
    });

    it("returns false when there is more than one root entry", () => {
        const tree: CollectionTree = {
            type: "dir",
            id: "root",
            name: "",
            entries: [
                { kind: "dir", node: { type: "dir", id: "d1", name: "Photos", entries: [] } },
                { kind: "dir", node: { type: "dir", id: "d2", name: "Videos", entries: [] } },
            ],
        };
        expect(hasRedundantCollectionRootDir(tree, "Photos")).toBe(false);
    });

    it("returns false when the single root entry is a file, not a dir", () => {
        const tree: CollectionTree = {
            type: "dir",
            id: "root",
            name: "",
            entries: [{ kind: "file", node: { type: "file", id: "f1", name: "Photos", size: 1 } }],
        };
        expect(hasRedundantCollectionRootDir(tree, "Photos")).toBe(false);
    });

    it("returns false for an empty tree", () => {
        const tree: CollectionTree = { type: "dir", id: "root", name: "", entries: [] };
        expect(hasRedundantCollectionRootDir(tree, "Photos")).toBe(false);
    });
});

describe("shouldCreateCollectionSubfolder", () => {
    it("returns true when enabled with multiple entries and no redundant root dir", () => {
        const tree: CollectionTree = {
            type: "dir",
            id: "root",
            name: "",
            entries: [
                { kind: "file", node: { type: "file", id: "f1", name: "a.txt", size: 1 } },
                { kind: "file", node: { type: "file", id: "f2", name: "b.txt", size: 1 } },
            ],
        };
        expect(shouldCreateCollectionSubfolder(tree, "Photos", true)).toBe(true);
    });

    it("returns false when the feature is disabled", () => {
        const tree: CollectionTree = {
            type: "dir",
            id: "root",
            name: "",
            entries: [
                { kind: "file", node: { type: "file", id: "f1", name: "a.txt", size: 1 } },
                { kind: "file", node: { type: "file", id: "f2", name: "b.txt", size: 1 } },
            ],
        };
        expect(shouldCreateCollectionSubfolder(tree, "Photos", false)).toBe(false);
    });

    it("returns false for a single redundant root dir even when enabled", () => {
        expect(shouldCreateCollectionSubfolder(dirTree("Photos"), "Photos", true)).toBe(false);
    });

    it("returns false for a single non-matching entry even when enabled", () => {
        const tree: CollectionTree = {
            type: "dir",
            id: "root",
            name: "",
            entries: [{ kind: "file", node: { type: "file", id: "f1", name: "a.txt", size: 1 } }],
        };
        expect(shouldCreateCollectionSubfolder(tree, "Photos", true)).toBe(false);
    });
});
