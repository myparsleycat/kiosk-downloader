import type { DirNode, FileNode, TreeEntry, ZipNode } from "@shared/types";
import {
    buildZipEntriesTree,
    hasSelectedDescendant,
    isPathSelected,
    isZipExtractMode,
    listZipNodes,
    setZipEntries,
} from "@shared/zip-tree";
import { describe, expect, it } from "vitest";

function sampleTree(): DirNode {
    return {
        type: "dir",
        id: "root",
        name: "",
        entries: [
            {
                kind: "zip",
                node: {
                    type: "zip",
                    id: "zip1",
                    name: "photos.zip",
                    size: 1000,
                    entries: null,
                },
            },
            {
                kind: "file",
                node: {
                    type: "file",
                    id: "f1",
                    name: "readme.txt",
                    size: 10,
                },
            },
        ],
    };
}

describe("zip selection helpers", () => {
    it("detects extract mode from descendant paths", () => {
        expect(isZipExtractMode("photos.zip", ["photos.zip/a.png"])).toBe(true);
        expect(isZipExtractMode("photos.zip", ["photos.zip"])).toBe(false);
        expect(hasSelectedDescendant("photos.zip", new Set(["photos.zip/dir/a.png"]))).toBe(true);
    });

    it("treats parent markers as non-selecting for isPathSelected", () => {
        expect(isPathSelected("photos.zip/dir/a.png", new Set(["photos.zip/dir"]))).toBe(false);
        expect(
            isPathSelected(
                "photos.zip/dir/a.png",
                new Set(["photos.zip/dir", "photos.zip/dir/a.png"]),
            ),
        ).toBe(true);
    });

    it("builds nested zip entry trees", () => {
        const entries = buildZipEntriesTree("zip1", [
            {
                path: "dir/a.png",
                name: "a.png",
                directory: false,
                offset: 0,
                compressedSize: 10,
                uncompressedSize: 20,
                compressionMethod: 0,
                encrypted: false,
            },
            {
                path: "dir/",
                name: "dir",
                directory: true,
                offset: 0,
                compressedSize: 0,
                uncompressedSize: 0,
                compressionMethod: 0,
                encrypted: false,
            },
        ]);
        expect(entries).toHaveLength(1);
        expect(entries[0].kind).toBe("dir");
        const dir = entries[0].node as DirNode;
        expect(dir.name).toBe("dir");
        expect(dir.entries.some((entry) => entry.kind === "file")).toBe(true);
        const file = dir.entries.find((entry) => entry.kind === "file")?.node as FileNode;
        expect(file.zipEntry?.path).toBe("dir/a.png");
        expect(file.zipEntry?.uncompressedSize).toBe(20);
    });

    it("merges indexed entries onto ZipNode", () => {
        const tree = sampleTree();
        const children: TreeEntry[] = [
            {
                kind: "file",
                node: {
                    type: "file",
                    id: "zip1:entry:a.png",
                    name: "a.png",
                    size: 20,
                    zipEntry: {
                        path: "a.png",
                        offset: 0,
                        compressedSize: 10,
                        uncompressedSize: 20,
                        compressionMethod: 0,
                        encrypted: false,
                    },
                },
            },
        ];
        const next = setZipEntries(tree, "zip1", children);
        const zip = listZipNodes(next)[0].zip;
        expect(zip.entries).toEqual(children);
        expect((sampleTree().entries[0].node as ZipNode).entries).toBeNull();
    });
});
