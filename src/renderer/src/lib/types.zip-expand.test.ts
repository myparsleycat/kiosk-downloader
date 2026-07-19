import type { DirNode, ZipNode } from "@shared/types";
import { setZipEntries } from "@shared/zip-tree";
import { describe, expect, it } from "vitest";

import { collectAllPaths, getSelectionCheckState, selectExpandedZipEntries } from "./types";

function rootWithUnexpandedZip(): { root: DirNode; zip: ZipNode } {
    const zip: ZipNode = {
        type: "zip",
        id: "z1",
        name: "archive.zip",
        size: 300,
        entries: null,
    };
    return {
        zip,
        root: {
            type: "dir",
            id: "root",
            name: "",
            entries: [{ kind: "zip", node: zip }],
        },
    };
}

function expand(root: DirNode) {
    return setZipEntries(root, "z1", [
        {
            kind: "file",
            node: { type: "file", id: "a", name: "a.bin", size: 100 },
        },
        {
            kind: "file",
            node: { type: "file", id: "b", name: "b.bin", size: 200 },
        },
    ]);
}

describe("selectExpandedZipEntries", () => {
    it("keeps a selected zip checked after its entries load", () => {
        const { root } = rootWithUnexpandedZip();
        const selected = collectAllPaths(root);
        const expanded = expand(root);
        const expandedZip = expanded.entries[0]?.node as ZipNode;

        const next = selectExpandedZipEntries(selected, expanded, "archive.zip", "z1");

        expect(next.has("archive.zip/a.bin")).toBe(true);
        expect(next.has("archive.zip/b.bin")).toBe(true);
        expect(getSelectionCheckState(next, "archive.zip", expandedZip)).toBe(true);
    });

    it("leaves an unselected zip untouched", () => {
        const { root } = rootWithUnexpandedZip();
        const expanded = expand(root);
        const expandedZip = expanded.entries[0]?.node as ZipNode;

        const selected = new Set<string>();
        const next = selectExpandedZipEntries(selected, expanded, "archive.zip", "z1");

        expect(next).toBe(selected);
        expect(getSelectionCheckState(next, "archive.zip", expandedZip)).toBe(false);
    });
});
