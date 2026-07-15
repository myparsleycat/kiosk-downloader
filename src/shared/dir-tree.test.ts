import { describe, expect, it } from "vitest";

import { buildDirTreeFromFiles, validateDirTreeFilePaths } from "./dir-tree";

describe("directory tree paths", () => {
    it("normalizes and builds nested file paths", () => {
        const tree = buildDirTreeFromFiles([
            { path: "/folder//nested/file.txt", name: "file.txt", size: 10 },
        ]);

        expect(tree.entries[0]?.node.id).toBe("folder");
        expect(validateDirTreeFilePaths([{ path: "/folder//nested/file.txt" }])).toEqual([
            "folder/nested/file.txt",
        ]);
    });

    it.each([
        [[{ path: "file.txt" }, { path: "/file.txt" }]],
        [[{ path: "foo" }, { path: "foo/bar.txt" }]],
        [[{ path: "foo/bar.txt" }, { path: "foo" }]],
    ])("rejects duplicate and file-directory collisions", (files) => {
        expect(() => validateDirTreeFilePaths(files)).toThrow("업로드");
    });
});
