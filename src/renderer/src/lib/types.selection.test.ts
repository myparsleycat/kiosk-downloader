import type { DirNode, ZipNode } from "@shared/types";
import { describe, expect, it } from "vitest";

import { getSelectionCheckState, summarizeSelection, toggleTreeSelection } from "./types";

function zipWithFolder(): DirNode {
    const zip: ZipNode = {
        type: "zip",
        id: "zip1",
        name: "archive.zip",
        size: 7000,
        entries: [
            {
                kind: "dir",
                node: {
                    type: "dir",
                    id: "zip1:dir",
                    name: "folder",
                    entries: [
                        {
                            kind: "file",
                            node: {
                                type: "file",
                                id: "zip1:a",
                                name: "a.bin",
                                size: 100,
                                zipEntry: {
                                    path: "folder/a.bin",
                                    offset: 0,
                                    compressedSize: 100,
                                    uncompressedSize: 100,
                                    compressionMethod: 0,
                                    encrypted: false,
                                },
                            },
                        },
                        {
                            kind: "file",
                            node: {
                                type: "file",
                                id: "zip1:b",
                                name: "b.bin",
                                size: 200,
                                zipEntry: {
                                    path: "folder/b.bin",
                                    offset: 100,
                                    compressedSize: 200,
                                    uncompressedSize: 200,
                                    compressionMethod: 0,
                                    encrypted: false,
                                },
                            },
                        },
                    ],
                },
            },
        ],
    };

    return {
        type: "dir",
        id: "root",
        name: "",
        entries: [{ kind: "zip", node: zip }],
    };
}

describe("summarizeSelection", () => {
    it("counts only the explicitly selected zip entry file", () => {
        const root = zipWithFolder();
        const selected = toggleTreeSelection(new Set(), "archive.zip/folder/a.bin", root);
        expect(selected.has("archive.zip/folder")).toBe(true);
        expect(summarizeSelection(selected, root)).toEqual({ count: 1, bytes: 100 });
    });

    it("counts all files when the folder is selected", () => {
        const root = zipWithFolder();
        const selected = toggleTreeSelection(new Set(), "archive.zip/folder", root);
        expect(summarizeSelection(selected, root)).toEqual({ count: 2, bytes: 300 });
    });
});

describe("getSelectionCheckState", () => {
    it("marks parent folder indeterminate when one child is selected", () => {
        const root = zipWithFolder();
        const selected = toggleTreeSelection(new Set(), "archive.zip/folder/a.bin", root);
        const zip = root.entries[0]?.node as ZipNode;
        const folder = zip.entries?.[0]?.node as DirNode;
        expect(getSelectionCheckState(selected, "archive.zip/folder", folder)).toBe(
            "indeterminate",
        );
        expect(getSelectionCheckState(selected, "archive.zip", zip)).toBe("indeterminate");
    });

    it("marks folder checked when fully selected", () => {
        const root = zipWithFolder();
        const selected = toggleTreeSelection(new Set(), "archive.zip/folder", root);
        const zip = root.entries[0]?.node as ZipNode;
        const folder = zip.entries?.[0]?.node as DirNode;
        expect(getSelectionCheckState(selected, "archive.zip/folder", folder)).toBe(true);
    });
});
