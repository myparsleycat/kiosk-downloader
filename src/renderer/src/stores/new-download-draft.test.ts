import type { Collection } from "@renderer/lib/types";
import { afterEach, describe, expect, it } from "vitest";

import {
    applyZipEntriesResult,
    canStartDownloads,
    createDownloadDraftItem,
    getStartableDraftItems,
    shouldLoadPastedShare,
    useNewDownloadDraft,
} from "./new-download-draft";

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

describe("bulk download draft", () => {
    afterEach(() => {
        useNewDownloadDraft.getState().resetDraft();
    });

    it("replaces a single draft with bulk items", () => {
        const store = useNewDownloadDraft.getState();
        store.replaceItems(["https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa"]);
        store.replaceItems([
            "https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa",
            "https://transfer.it/t/abcd1234ef56",
        ]);

        const next = useNewDownloadDraft.getState();
        expect(next.url).toBe("");
        expect(next.items.map((item) => item.url)).toEqual([
            "https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa",
            "https://transfer.it/t/abcd1234ef56",
        ]);
        expect(next.items.every((item) => item.preparation.status === "preparing")).toBe(true);
    });

    it("keeps a single URL in the input buffer", () => {
        useNewDownloadDraft.getState().replaceItems(["https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa"]);
        expect(useNewDownloadDraft.getState().url).toBe("https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa");
        expect(useNewDownloadDraft.getState().items).toHaveLength(1);
    });

    it("keeps password and error items out of the startable set", () => {
        const ready = createDownloadDraftItem("https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa");
        ready.preparation = {
            status: "ready",
            draftId: "draft-1",
            collection: collection([]),
        };
        ready.selected = new Set(["a.txt"]);
        const locked = createDownloadDraftItem("https://transfer.it/t/abcd1234ef56");
        locked.preparation = { status: "passwordRequired", invalid: false };
        const failed = createDownloadDraftItem("https://workupload.com/file/aaaaaaaaaaa");
        failed.preparation = { status: "error", message: "remote down" };

        expect(getStartableDraftItems([ready, locked, failed])).toEqual([ready]);
        expect(canStartDownloads([ready, locked, failed], "E:\\Downloads")).toBe(true);
        expect(canStartDownloads([locked, failed], "E:\\Downloads")).toBe(false);
    });

    it("does not start while any item is still preparing", () => {
        const ready = createDownloadDraftItem("https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa");
        ready.preparation = {
            status: "ready",
            draftId: "draft-1",
            collection: collection([]),
        };
        ready.selected = new Set(["a.txt"]);
        const loading = createDownloadDraftItem("https://transfer.it/t/abcd1234ef56");

        expect(canStartDownloads([ready, loading], "E:\\Downloads")).toBe(false);
    });

    it("reloads a pasted share only when it is not already the single draft", () => {
        const current = createDownloadDraftItem("https://kio.ac/c/aaaaaaaaaaaaaaaaaaaaaa");
        expect(shouldLoadPastedShare([current], current.url)).toBe(false);
        expect(
            shouldLoadPastedShare(
                [current, createDownloadDraftItem("https://transfer.it/t/abcd1234ef56")],
                current.url,
            ),
        ).toBe(true);
        expect(shouldLoadPastedShare([current], "https://transfer.it/t/abcd1234ef56")).toBe(true);
        expect(shouldLoadPastedShare([], current.url)).toBe(true);
    });
});
