import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { filePathsFromUriList, processChunked } from "./util-pure";

describe("filePathsFromUriList", () => {
    it("converts file URIs to filesystem paths", () => {
        expect(filePathsFromUriList("file:///tmp/a.txt")).toEqual([
            fileURLToPath("file:///tmp/a.txt"),
        ]);
        expect(filePathsFromUriList("file:///C:/Downloads/a.txt")).toEqual([
            fileURLToPath("file:///C:/Downloads/a.txt"),
        ]);
    });

    it("keeps multiple file URIs in list order", () => {
        expect(filePathsFromUriList("file:///tmp/a.txt\r\nfile:///tmp/b.txt")).toEqual([
            fileURLToPath("file:///tmp/a.txt"),
            fileURLToPath("file:///tmp/b.txt"),
        ]);
    });

    it("skips comments, blanks, and non-file URIs", () => {
        expect(
            filePathsFromUriList(
                [
                    "# comment",
                    "",
                    "  ",
                    "http://example.com",
                    "file:///tmp/a.txt",
                    "https://example.com",
                ].join("\n"),
            ),
        ).toEqual([fileURLToPath("file:///tmp/a.txt")]);
    });

    it("skips malformed file URIs", () => {
        expect(filePathsFromUriList("file://[\nfile:///tmp/a.txt")).toEqual([
            fileURLToPath("file:///tmp/a.txt"),
        ]);
    });

    it("returns an empty array when there are no file URIs", () => {
        expect(filePathsFromUriList("")).toEqual([]);
        expect(filePathsFromUriList("# only a comment")).toEqual([]);
    });
});

describe("processChunked", () => {
    it("invokes the processor for every item when below the chunk boundary", async () => {
        const items = Array.from({ length: 5 }, (_, i) => i);
        const processor = vi.fn();
        await processChunked(items, processor, 1000);
        expect(processor).toHaveBeenCalledTimes(5);
        expect(processor.mock.calls.map(([v]) => v)).toEqual([0, 1, 2, 3, 4]);
    });

    it("processes all items across multiple chunks", async () => {
        const items = Array.from({ length: 7 }, (_, i) => i);
        const processor = vi.fn();
        await processChunked(items, processor, 3);
        expect(processor).toHaveBeenCalledTimes(7);
        expect(processor.mock.calls.map(([v]) => v)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it("handles an empty array without calling the processor", async () => {
        const processor = vi.fn();
        await processChunked([], processor);
        expect(processor).not.toHaveBeenCalled();
    });

    it("stops processing when the abort signal fires at a chunk boundary", async () => {
        const controller = new AbortController();
        const processed: number[] = [];
        const processor = vi.fn((v: number) => {
            processed.push(v);
            // Abort after the first chunk (size 3) completes, before the next chunk starts.
            if (processed.length === 3) {
                controller.abort();
            }
        });
        const items = Array.from({ length: 9 }, (_, i) => i);
        await processChunked(items, processor, 3, controller.signal);
        expect(processed).toEqual([0, 1, 2]);
        expect(processor).toHaveBeenCalledTimes(3);
    });

    it("does not abort mid-chunk; only checks between chunks", async () => {
        // Even though the signal aborts during item 1, items 0-2 (the whole first
        // chunk) still run because the abort check is only at chunk boundaries.
        const controller = new AbortController();
        const processed: number[] = [];
        const processor = (v: number) => {
            processed.push(v);
            if (v === 1) controller.abort();
        };
        const items = Array.from({ length: 6 }, (_, i) => i);
        await processChunked(items, processor, 3, controller.signal);
        expect(processed).toEqual([0, 1, 2]);
    });
});
