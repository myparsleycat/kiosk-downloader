import { buildZipEntriesTree } from "@shared/zip-tree";
import {
    BlobWriter,
    TextReader,
    Uint8ArrayReader,
    ZipReader,
    ZipWriter,
    configure,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

configure({ useWebWorkers: false });

describe("zip.js fixture indexing", () => {
    it("parses stored and deflated entries from a generated zip", async () => {
        const writer = new ZipWriter(new BlobWriter("application/zip"));
        await writer.add("hello.txt", new TextReader("hello"), { level: 0 });
        await writer.add("nested/world.txt", new TextReader("world"), { level: 6 });
        const blob = await writer.close();
        const bytes = new Uint8Array(await blob.arrayBuffer());

        const reader = new ZipReader(new Uint8ArrayReader(bytes));
        const entries = await reader.getEntries();
        await reader.close();

        const indexed = entries.map((entry) => ({
            path: entry.filename.replace(/\\/g, "/"),
            name: entry.filename.split("/").filter(Boolean).at(-1) ?? entry.filename,
            directory: entry.directory,
            offset: entry.offset,
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize,
            compressionMethod: entry.compressionMethod,
            encrypted: entry.encrypted,
        }));

        const tree = buildZipEntriesTree("remote", indexed);
        expect(tree.some((entry) => entry.kind === "file" && entry.node.name === "hello.txt")).toBe(
            true,
        );
        expect(tree.some((entry) => entry.kind === "dir" && entry.node.name === "nested")).toBe(
            true,
        );

        const hello = indexed.find((entry) => entry.path === "hello.txt");
        const world = indexed.find((entry) => entry.path === "nested/world.txt");
        expect(hello?.compressionMethod).toBe(0);
        expect(world?.compressionMethod).toBe(8);
        expect(hello?.uncompressedSize).toBe(5);
        expect(world?.uncompressedSize).toBe(5);
    });
});
