import type { DirNode } from "@shared/types";
import { describe, expect, it } from "vitest";

import { flattenDownloadTree } from "./repository";

describe("flattenDownloadTree", () => {
    it("keeps unselected ZIP entries so they can be included later", () => {
        const tree: DirNode = {
            type: "dir",
            id: "root",
            name: "",
            entries: [
                {
                    kind: "zip",
                    node: {
                        type: "zip",
                        id: "archive",
                        name: "archive.zip",
                        size: 7_000,
                        entries: [
                            {
                                kind: "file",
                                node: {
                                    type: "file",
                                    id: "selected",
                                    name: "selected.bin",
                                    size: 1_000,
                                    zipEntry: {
                                        path: "selected.bin",
                                        compressionMethod: 8,
                                        compressedSize: 500,
                                        uncompressedSize: 1_000,
                                        offset: 0,
                                        encrypted: false,
                                    },
                                },
                            },
                            {
                                kind: "file",
                                node: {
                                    type: "file",
                                    id: "excluded",
                                    name: "excluded.bin",
                                    size: 6_000,
                                    zipEntry: {
                                        path: "excluded.bin",
                                        compressionMethod: 8,
                                        compressedSize: 3_000,
                                        uncompressedSize: 6_000,
                                        offset: 500,
                                        encrypted: false,
                                    },
                                },
                            },
                        ],
                    },
                },
            ],
        };

        expect(
            flattenDownloadTree(tree, new Set(["archive.zip/selected.bin"]), undefined),
        ).toMatchObject([
            { path: "archive.zip/selected.bin", selected: true },
            { path: "archive.zip/excluded.bin", selected: false },
        ]);
    });
});
