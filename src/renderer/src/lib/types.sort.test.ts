import type { DirNode, TreeEntry, ZipNode } from "@shared/types";
import { describe, expect, it } from "vitest";

import { sortTree } from "./types";

const root: DirNode = {
    type: "dir",
    id: "root",
    name: "",
    entries: [
        {
            kind: "file",
            node: { type: "file", id: "f10", name: "file10.bin", size: 10 },
        },
        {
            kind: "file",
            node: { type: "file", id: "f2", name: "file2.bin", size: 20 },
        },
        {
            kind: "zip",
            node: { type: "zip", id: "z2", name: "zip2.zip", size: 40, entries: null },
        },
        {
            kind: "zip",
            node: {
                type: "zip",
                id: "z10",
                name: "zip10.zip",
                size: 100,
                entries: [
                    {
                        kind: "file",
                        node: { type: "file", id: "za", name: "z.bin", size: 30 },
                    },
                    {
                        kind: "file",
                        node: { type: "file", id: "zb", name: "a.bin", size: 50 },
                    },
                ],
            },
        },
        {
            kind: "dir",
            node: {
                type: "dir",
                id: "small",
                name: "dir2",
                entries: [
                    {
                        kind: "file",
                        node: { type: "file", id: "small-file", name: "only.bin", size: 5 },
                    },
                ],
            },
        },
        {
            kind: "dir",
            node: {
                type: "dir",
                id: "large",
                name: "dir10",
                entries: [
                    {
                        kind: "file",
                        node: { type: "file", id: "large-file", name: "only.bin", size: 60 },
                    },
                ],
            },
        },
    ],
};

function names(entries: TreeEntry[], kind: TreeEntry["kind"]) {
    return entries.filter((entry) => entry.kind === kind).map((entry) => entry.node.name);
}

describe("sortTree", () => {
    it("uses the name comparator for every entry group and nested zip entries", () => {
        const sorted = sortTree(root, "name", "asc");

        expect(names(sorted.entries, "dir")).toEqual(["dir2", "dir10"]);
        expect(names(sorted.entries, "zip")).toEqual(["zip2.zip", "zip10.zip"]);
        expect(names(sorted.entries, "file")).toEqual(["file2.bin", "file10.bin"]);
        expect(
            (
                sorted.entries.find((entry) => entry.node.id === "z10")?.node as ZipNode | undefined
            )?.entries?.map((entry) => entry.node.name),
        ).toEqual(["a.bin", "z.bin"]);
    });

    it("uses aggregate size for directories and expanded zips", () => {
        const sorted = sortTree(root, "size", "desc");

        expect(names(sorted.entries, "dir")).toEqual(["dir10", "dir2"]);
        expect(names(sorted.entries, "zip")).toEqual(["zip10.zip", "zip2.zip"]);
        expect(names(sorted.entries, "file")).toEqual(["file2.bin", "file10.bin"]);
    });

    it("returns the original tree when sorting is disabled", () => {
        expect(sortTree(root, "name", "none")).toBe(root);
    });
});
