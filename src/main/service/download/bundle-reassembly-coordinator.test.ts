import { createHash } from "node:crypto";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";
import type { DownloadCollectionRow } from "./types";

import { BundleReassemblyCoordinator } from "./bundle-reassembly-coordinator";

const testDirs: string[] = [];

afterEach(async () => {
    await Promise.all(testDirs.splice(0).map((dir) => fse.remove(dir)));
});

function createKd(): KioskDownloader {
    return {
        lib: {
            fs: {
                getSafeRelativePath: vi.fn((p: string) => p),
            },
        },
    } as unknown as KioskDownloader;
}

function createCollection(id: string, ordinal: number, savePath: string): DownloadCollectionRow {
    return {
        id,
        shareId: `share-${id}`,
        sourceUrl: `https://example.test/${id}`,
        passwordPlain: null,
        name: id,
        rootId: `root-${id}`,
        segmentSize: 1024,
        expires: Math.floor(Date.now() / 1000) + 3600,
        treeJson: "{}",
        savePath,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        elapsedMs: 0,
        error: null,
        asciiFilenames: 0,
        provider: "kiosk",
        bundleId: "bundle-1",
        ordinal,
    };
}

describe("BundleReassemblyCoordinator", () => {
    it("incrementally appends multi-piece split files in offset order and publishes a verified file", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".reassembly-coord-test-"));
        testDirs.push(dir);

        const collection0 = createCollection("col-0", 0, path.join(dir, "col-0"));
        const collection1 = createCollection("col-1", 1, path.join(dir, "col-1"));
        await fse.ensureDir(collection0.savePath);
        await fse.ensureDir(collection1.savePath);

        const piece0Data = Buffer.from("hello ");
        const piece1Data = Buffer.from("extended upload");
        const piece0Path = path.join(collection0.savePath, "piece0.bin");
        const piece1Path = path.join(collection1.savePath, "piece1.bin");
        await fse.writeFile(piece0Path, piece0Data);
        await fse.writeFile(piece1Path, piece1Data);

        const expected = Buffer.concat([piece0Data, piece1Data]);
        const manifest = {
            renames: {},
            splitFiles: [
                {
                    path: "output.bin",
                    size: expected.length,
                    sha256: createHash("sha256").update(expected).digest("hex"),
                    pieces: [
                        {
                            sourceIndex: 0,
                            remoteFileId: "remote-0",
                            offset: 0,
                            length: piece0Data.length,
                        },
                        {
                            sourceIndex: 1,
                            remoteFileId: "remote-1",
                            offset: piece0Data.length,
                            length: piece1Data.length,
                        },
                    ],
                },
            ],
        };

        const coordinator = new BundleReassemblyCoordinator(
            createKd(),
            "bundle-1",
            dir,
            manifest,
            [collection0, collection1],
            (piece) => {
                if (piece.sourceIndex === 0 && piece.remoteFileId === "remote-0") return piece0Path;
                if (piece.sourceIndex === 1 && piece.remoteFileId === "remote-1") return piece1Path;
                return null;
            },
        );

        expect(coordinator.hasManagedFiles()).toBe(true);
        expect(coordinator.isPieceManaged("col-0", "remote-0")).toBe(true);
        expect(coordinator.isPieceManaged("col-1", "remote-1")).toBe(true);

        await coordinator.onPieceFileSettled("col-1", "remote-1");
        expect(coordinator.isComplete()).toBe(false);
        expect(await fse.pathExists(path.join(dir, "output.bin"))).toBe(false);

        const result = await coordinator.onPieceFileSettled("col-0", "remote-0");
        expect(result.publishedPaths).toEqual([path.join(dir, "output.bin")]);
        expect(coordinator.isComplete()).toBe(true);
        expect(await fse.readFile(path.join(dir, "output.bin"))).toEqual(expected);
        expect(await fse.pathExists(path.join(dir, "output.bin.part"))).toBe(false);

        expect(await fse.pathExists(piece0Path)).toBe(false);
        expect(await fse.pathExists(piece1Path)).toBe(false);
    });

    it("immediately extracts small files from a pack when the pack finishes downloading", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".reassembly-coord-test-"));
        testDirs.push(dir);

        const collection0 = createCollection("col-0", 0, path.join(dir, "col-0"));
        await fse.ensureDir(collection0.savePath);

        const fileA = Buffer.from("first file content");
        const fileB = Buffer.from("second");
        const fileC = Buffer.from("third file data here");
        const packData = Buffer.concat([fileA, fileB, fileC]);
        const packPath = path.join(collection0.savePath, "pack_0_0");
        await fse.writeFile(packPath, packData);

        const manifest = {
            renames: {},
            splitFiles: [
                {
                    path: "a.txt",
                    size: fileA.length,
                    sha256: undefined,
                    pieces: [
                        {
                            sourceIndex: 0,
                            remoteFileId: "remote-pack",
                            offset: 0,
                            length: fileA.length,
                            remoteOffset: 0,
                        },
                    ],
                },
                {
                    path: "b.txt",
                    size: fileB.length,
                    sha256: undefined,
                    pieces: [
                        {
                            sourceIndex: 0,
                            remoteFileId: "remote-pack",
                            offset: 0,
                            length: fileB.length,
                            remoteOffset: fileA.length,
                        },
                    ],
                },
                {
                    path: "c.txt",
                    size: fileC.length,
                    sha256: undefined,
                    pieces: [
                        {
                            sourceIndex: 0,
                            remoteFileId: "remote-pack",
                            offset: 0,
                            length: fileC.length,
                            remoteOffset: fileA.length + fileB.length,
                        },
                    ],
                },
            ],
        };

        const coordinator = new BundleReassemblyCoordinator(
            createKd(),
            "bundle-1",
            dir,
            manifest,
            [collection0],
            () => packPath,
        );

        expect(coordinator.hasManagedFiles()).toBe(true);
        expect(coordinator.isPieceManaged("col-0", "remote-pack")).toBe(true);

        const result = await coordinator.onPieceFileSettled("col-0", "remote-pack");

        expect(result.publishedPaths).toHaveLength(3);
        expect(await fse.readFile(path.join(dir, "a.txt"))).toEqual(fileA);
        expect(await fse.readFile(path.join(dir, "b.txt"))).toEqual(fileB);
        expect(await fse.readFile(path.join(dir, "c.txt"))).toEqual(fileC);
        expect(await fse.pathExists(packPath)).toBe(false);
        expect(coordinator.isComplete()).toBe(true);
    });

    it("deletes partial assembly on teardown and prevents further publishing", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".reassembly-coord-test-"));
        testDirs.push(dir);

        const collection0 = createCollection("col-0", 0, path.join(dir, "col-0"));
        const collection1 = createCollection("col-1", 1, path.join(dir, "col-1"));
        await fse.ensureDir(collection0.savePath);
        await fse.ensureDir(collection1.savePath);

        const piece0Data = Buffer.from("first piece ");
        const piece1Data = Buffer.from("second piece");
        const piece0Path = path.join(collection0.savePath, "piece0.bin");
        const piece1Path = path.join(collection1.savePath, "piece1.bin");
        await fse.writeFile(piece0Path, piece0Data);
        await fse.writeFile(piece1Path, piece1Data);

        const expected = Buffer.concat([piece0Data, piece1Data]);
        const manifest = {
            renames: {},
            splitFiles: [
                {
                    path: "output.bin",
                    size: expected.length,
                    sha256: createHash("sha256").update(expected).digest("hex"),
                    pieces: [
                        {
                            sourceIndex: 0,
                            remoteFileId: "remote-0",
                            offset: 0,
                            length: piece0Data.length,
                        },
                        {
                            sourceIndex: 1,
                            remoteFileId: "remote-1",
                            offset: piece0Data.length,
                            length: piece1Data.length,
                        },
                    ],
                },
            ],
        };

        const coordinator = new BundleReassemblyCoordinator(
            createKd(),
            "bundle-1",
            dir,
            manifest,
            [collection0, collection1],
            (piece) => {
                if (piece.sourceIndex === 0 && piece.remoteFileId === "remote-0") return piece0Path;
                if (piece.sourceIndex === 1 && piece.remoteFileId === "remote-1") return piece1Path;
                return null;
            },
        );

        await coordinator.onPieceFileSettled("col-0", "remote-0");
        expect(coordinator.isComplete()).toBe(false);

        await coordinator.teardown();

        const result = await coordinator.onPieceFileSettled("col-1", "remote-1");
        expect(result.publishedPaths).toEqual([]);
        expect(await fse.pathExists(path.join(dir, "output.bin"))).toBe(false);
    });

    it("detects hash mismatch in multi-piece reassembly and does not publish", async () => {
        const dir = await fse.mkdtemp(path.join(process.cwd(), ".reassembly-coord-test-"));
        testDirs.push(dir);

        const collection0 = createCollection("col-0", 0, path.join(dir, "col-0"));
        const collection1 = createCollection("col-1", 1, path.join(dir, "col-1"));
        await fse.ensureDir(collection0.savePath);
        await fse.ensureDir(collection1.savePath);

        const piece0Data = Buffer.from("corrupt ");
        const piece1Data = Buffer.from("data");
        const piece0Path = path.join(collection0.savePath, "piece0.bin");
        const piece1Path = path.join(collection1.savePath, "piece1.bin");
        await fse.writeFile(piece0Path, piece0Data);
        await fse.writeFile(piece1Path, piece1Data);

        const manifest = {
            renames: {},
            splitFiles: [
                {
                    path: "output.bin",
                    size: piece0Data.length + piece1Data.length,
                    sha256: "0".repeat(64),
                    pieces: [
                        {
                            sourceIndex: 0,
                            remoteFileId: "remote-0",
                            offset: 0,
                            length: piece0Data.length,
                        },
                        {
                            sourceIndex: 1,
                            remoteFileId: "remote-1",
                            offset: piece0Data.length,
                            length: piece1Data.length,
                        },
                    ],
                },
            ],
        };

        const coordinator = new BundleReassemblyCoordinator(
            createKd(),
            "bundle-1",
            dir,
            manifest,
            [collection0, collection1],
            (piece) => {
                if (piece.sourceIndex === 0 && piece.remoteFileId === "remote-0") return piece0Path;
                if (piece.sourceIndex === 1 && piece.remoteFileId === "remote-1") return piece1Path;
                return null;
            },
        );

        await coordinator.onPieceFileSettled("col-0", "remote-0");
        await expect(coordinator.onPieceFileSettled("col-1", "remote-1")).rejects.toThrow("해시");
        expect(await fse.pathExists(path.join(dir, "output.bin"))).toBe(false);
    });
});
