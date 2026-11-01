import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import originalFs from "original-fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectUploadSources } from "./collect-sources";
import { readSegmentBytes } from "./kio-upload-client";
import { planIntegratedBundle, PlanProgressReporter } from "./preparation-core";
import { materializeSmallFilePack } from "./small-file-pack";

// Under plain Node there is no asar patch, so these only catch the bug when run under Electron:
// ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run collect-sources
// The bytes are a minimal archive: a pickled header followed by no file data.
function validAsarBytes() {
    const json = Buffer.from('{"files":{}}');
    const padded = Buffer.alloc((json.length + 3) & ~3);
    json.copy(padded);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(padded.length + 8, 4);
    header.writeUInt32LE(padded.length + 4, 8);
    header.writeUInt32LE(json.length, 12);
    return Buffer.concat([header, padded]);
}

describe("collectUploadSources", () => {
    let dir: string;

    beforeEach(() => {
        dir = originalFs.mkdtempSync(path.join(os.tmpdir(), "collect-sources-"));
    });

    afterEach(() => {
        originalFs.rmSync(dir, { recursive: true, force: true });
    });

    it.each([
        ["valid", validAsarBytes()],
        ["invalid", Buffer.alloc(4096, 7)],
    ])("lists an %s .asar as a single file in a folder scan", async (_label, bytes) => {
        const root = path.join(dir, "game");
        originalFs.mkdirSync(path.join(root, "resources"), { recursive: true });
        originalFs.writeFileSync(path.join(root, "resources", "app.asar"), bytes);
        originalFs.writeFileSync(path.join(root, "resources", "x.txt"), "x");

        const { sources } = await collectUploadSources([root], 10);

        expect(
            sources
                .toSorted((a, b) => a.path.localeCompare(b.path))
                .map((source) => [source.path, source.size]),
        ).toEqual([
            ["game/resources/app.asar", bytes.length],
            ["game/resources/x.txt", 1],
        ]);
    });

    it("treats a directly selected .asar as a file through planning and upload reads", async () => {
        const bytes = validAsarBytes();
        const file = path.join(dir, "app.asar");
        originalFs.writeFileSync(file, bytes);

        const { sources } = await collectUploadSources([file], 10);
        expect(sources).toMatchObject([{ path: "app.asar", size: bytes.length, fsPath: file }]);

        const plan = await planIntegratedBundle(
            sources,
            "bundle",
            path.join(dir, "packs"),
            new PlanProgressReporter(vi.fn()),
        );
        expect(JSON.stringify(plan)).toContain(createHash("sha256").update(bytes).digest("hex"));

        const read = await readSegmentBytes({
            fileId: Buffer.alloc(16),
            relativePath: "app.asar",
            size: bytes.length,
            offset: 0,
            sequence: 0,
            length: bytes.length,
            fsPath: file,
            sourceMtimeMs: sources[0]!.sourceMtimeMs,
        });
        expect(read.equals(bytes)).toBe(true);
    });

    it("packs a small .asar source into a pack file", async () => {
        const bytes = validAsarBytes();
        const file = path.join(dir, "app.asar");
        originalFs.writeFileSync(file, bytes);

        const packed = await materializeSmallFilePack({
            path: "pack/0",
            name: "0",
            size: bytes.length,
            fsPath: path.join(dir, "pack.bin"),
            sourceMtimeMs: 0,
            logicalPath: "pack/0",
            logicalSize: bytes.length,
            packEntries: [
                {
                    fsPath: file,
                    sourceMtimeMs: Math.trunc(originalFs.statSync(file).mtimeMs),
                    path: "app.asar",
                    size: bytes.length,
                    remoteOffset: 0,
                    contentSha256: createHash("sha256").update(bytes).digest("hex"),
                },
            ],
        });

        expect(originalFs.readFileSync(packed.fsPath).equals(bytes)).toBe(true);
    });
});
