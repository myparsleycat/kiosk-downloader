import {
    applyRenamesToTree,
    displayPathToOriginal,
    hasSiblingNameConflict,
    hasUploadPathConflict,
    renameUploadFiles,
    rewritePathSet,
    toDisplayPath,
    validateNodeName,
} from "@shared/tree-rename";
import type { DirNode } from "@shared/types";
import { describe, expect, it } from "vitest";

function sampleTree(): DirNode {
    return {
        type: "dir",
        id: "root",
        name: "",
        entries: [
            {
                kind: "dir",
                node: {
                    type: "dir",
                    id: "photos",
                    name: "photos",
                    entries: [
                        {
                            kind: "file",
                            node: {
                                type: "file",
                                id: "f1",
                                name: "a.jpg",
                                size: 10,
                            },
                        },
                        {
                            kind: "file",
                            node: {
                                type: "file",
                                id: "f2",
                                name: "b.jpg",
                                size: 20,
                            },
                        },
                    ],
                },
            },
            {
                kind: "file",
                node: {
                    type: "file",
                    id: "f3",
                    name: "readme.txt",
                    size: 5,
                },
            },
            {
                kind: "zip",
                node: {
                    type: "zip",
                    id: "z1",
                    name: "archive.zip",
                    size: 100,
                    entries: [
                        {
                            kind: "file",
                            node: {
                                type: "file",
                                id: "z1:entry:x.bin",
                                name: "x.bin",
                                size: 1,
                            },
                        },
                    ],
                },
            },
        ],
    };
}

describe("validateNodeName", () => {
    it("rejects empty, dots, and invalid characters", () => {
        expect(validateNodeName("")).toBeTruthy();
        expect(validateNodeName(".")).toBeTruthy();
        expect(validateNodeName("a/b")).toBeTruthy();
        expect(validateNodeName("   ")).toBeTruthy();
        expect(validateNodeName("ok.txt")).toBeNull();
    });
});

describe("applyRenamesToTree", () => {
    it("renames folders and rewrites descendant display names", () => {
        const renamed = applyRenamesToTree(sampleTree(), {
            photos: "Images",
            "photos/a.jpg": "alpha.jpg",
        });
        const dir = renamed.entries.find((entry) => entry.kind === "dir")?.node as DirNode;
        expect(dir.name).toBe("Images");
        expect(dir.entries.map((entry) => entry.node.name)).toEqual(["alpha.jpg", "b.jpg"]);
    });

    it("renames zip nodes and nested entries", () => {
        const renamed = applyRenamesToTree(sampleTree(), {
            "archive.zip": "data.zip",
            "archive.zip/x.bin": "payload.bin",
        });
        const zip = renamed.entries.find((entry) => entry.kind === "zip")?.node;
        expect(zip?.name).toBe("data.zip");
        expect(zip && "entries" in zip ? zip.entries?.[0]?.node.name : null).toBe("payload.bin");
    });
});

describe("path mapping", () => {
    it("maps original paths to display paths", () => {
        const renames = { photos: "Images", "photos/a.jpg": "alpha.jpg" };
        expect(toDisplayPath("photos/a.jpg", renames)).toBe("Images/alpha.jpg");
        expect(toDisplayPath("photos/b.jpg", renames)).toBe("Images/b.jpg");
    });

    it("maps display paths back to original paths", () => {
        const renames = { photos: "Images", "photos/a.jpg": "alpha.jpg" };
        expect(displayPathToOriginal(sampleTree(), renames, "Images/alpha.jpg")).toBe(
            "photos/a.jpg",
        );
        expect(displayPathToOriginal(sampleTree(), renames, "readme.txt")).toBe("readme.txt");
    });
});

describe("sibling conflict", () => {
    it("detects case-insensitive sibling name conflicts", () => {
        const tree = applyRenamesToTree(sampleTree(), {});
        expect(hasSiblingNameConflict(tree, "photos", "b.jpg", "photos/a.jpg")).toBe(true);
        expect(hasSiblingNameConflict(tree, "photos", "c.jpg", "photos/a.jpg")).toBe(false);
        // same node can change case; conflict only against other siblings
        expect(hasSiblingNameConflict(tree, "", "README.TXT", "readme.txt")).toBe(false);
        expect(hasSiblingNameConflict(tree, "", "README.TXT", "photos")).toBe(true);
    });
});

describe("path rewrite helpers", () => {
    it("rewrites selected path sets for folder renames", () => {
        const next = rewritePathSet(
            new Set(["photos", "photos/a.jpg", "readme.txt"]),
            "photos",
            "Images",
        );
        expect([...next].sort()).toEqual(["Images", "Images/a.jpg", "readme.txt"]);
    });
});

describe("upload rename", () => {
    it("renames files and folder prefixes", () => {
        const files = [
            { path: "Docs/a.pdf", name: "a.pdf", size: 1, sourceMtimeMs: 1 },
            { path: "Docs/b.pdf", name: "b.pdf", size: 1, sourceMtimeMs: 1 },
            { path: "other.txt", name: "other.txt", size: 1, sourceMtimeMs: 1 },
        ];
        expect(renameUploadFiles(files, "Docs", "Reports")).toEqual([
            { path: "Reports/a.pdf", name: "a.pdf", size: 1, sourceMtimeMs: 1 },
            { path: "Reports/b.pdf", name: "b.pdf", size: 1, sourceMtimeMs: 1 },
            { path: "other.txt", name: "other.txt", size: 1, sourceMtimeMs: 1 },
        ]);
        expect(renameUploadFiles(files, "Docs/a.pdf", "report.pdf")[0]).toEqual({
            path: "Docs/report.pdf",
            name: "report.pdf",
            size: 1,
            sourceMtimeMs: 1,
        });
    });

    it("detects upload path collisions", () => {
        const files = [
            { path: "a.txt", name: "a.txt" },
            { path: "b.txt", name: "b.txt" },
        ];
        expect(hasUploadPathConflict(files, "a.txt", "b.txt")).toBe(true);
        expect(hasUploadPathConflict(files, "a.txt", "c.txt")).toBe(false);
    });
});
