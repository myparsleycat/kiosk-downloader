import type { Collection } from "@renderer/lib/types";
import { describe, expect, it } from "vitest";

import { applyZipEntriesResult } from "./new-download-draft";

function collection(entries: Collection["tree"]["entries"]): Collection {
    return {
        shareId: "share",
        name: "Prepared",
        expires: 4_102_444_800,
        segmentSize: 16,
        passwordProtected: false,
        tree: {
            type: "dir",
            id: "root",
            name: "",
            entries,
        },
    };
}

function zipEntry(id: string, name: string, nested?: Collection["tree"]["entries"]) {
    return {
        kind: "zip" as const,
        node: {
            type: "zip" as const,
            id,
            name,
            size: 10,
            entries: nested ?? null,
        },
    };
}

const zipFile = {
    kind: "file" as const,
    node: { type: "file" as const, id: "inside", name: "inside.txt", size: 1 },
};

describe("applyZipEntriesResult", () => {
    it("ignores a staleDraft response for a replacement draft", () => {
        expect(
            applyZipEntriesResult(
                "old-draft",
                {
                    status: "ready",
                    draftId: "new-draft",
                    collection: collection([zipEntry("zip-1", "a.zip")]),
                },
                {
                    status: "failed",
                    code: "staleDraft",
                    message: "Prepared download draft is no longer available.",
                },
                "zip-1",
            ),
        ).toEqual({ action: "ignore" });
    });

    it("clears only when the stale draft is still current", () => {
        expect(
            applyZipEntriesResult(
                "old-draft",
                {
                    status: "ready",
                    draftId: "old-draft",
                    collection: collection([zipEntry("zip-1", "a.zip")]),
                },
                {
                    status: "failed",
                    code: "staleDraft",
                    message: "Prepared download draft is no longer available.",
                },
                "zip-1",
            ),
        ).toEqual({ action: "clear" });
    });

    it("applies ZIP entries onto the current tree instead of a captured snapshot", () => {
        const current = collection([
            zipEntry("zip-1", "a.zip", [zipFile]),
            zipEntry("zip-2", "b.zip"),
        ]);
        const applied = applyZipEntriesResult(
            "draft",
            { status: "ready", draftId: "draft", collection: current },
            { status: "ready", entries: [zipFile] },
            "zip-2",
        );

        expect(applied).toMatchObject({ action: "ready" });
        if (applied.action !== "ready") {
            throw new Error("Expected ZIP entries to apply");
        }
        expect(applied.nextTree.entries[0]).toEqual(zipEntry("zip-1", "a.zip", [zipFile]));
        expect(applied.nextTree.entries[1]).toEqual(zipEntry("zip-2", "b.zip", [zipFile]));
    });
});
