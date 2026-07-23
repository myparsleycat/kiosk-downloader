import { createHash } from "node:crypto";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UploadSourceFile } from "./types";

import { materializePacks, PlanProgressReporter, planIntegratedBundle } from "./preparation-core";

const testDirs: string[] = [];

afterEach(async () => {
    await Promise.all(testDirs.splice(0).map((dir) => fse.remove(dir)));
});

async function makeSourceDir(files: Array<{ name: string; content: string }>) {
    const dir = await fse.mkdtemp(path.join(process.cwd(), ".prep-core-test-"));
    testDirs.push(dir);
    const sources: UploadSourceFile[] = [];
    for (const { name, content } of files) {
        const fsPath = path.join(dir, name);
        await fse.ensureDir(path.dirname(fsPath));
        await fse.writeFile(fsPath, content);
        const stat = await fse.stat(fsPath);
        sources.push({
            path: name,
            name,
            size: stat.size,
            fsPath,
            sourceMtimeMs: Math.trunc(stat.mtimeMs),
        });
    }
    return { dir, sources };
}

function sha256Of(content: string) {
    return createHash("sha256").update(content).digest("hex");
}

describe("planIntegratedBundle", () => {
    it("produces deterministic plans for the same files regardless of input order", async () => {
        const { dir, sources } = await makeSourceDir([
            { name: "a.txt", content: "alpha" },
            { name: "b.txt", content: "bravo" },
            { name: "c.txt", content: "charlie" },
        ]);
        const packDir = path.join(dir, "packs");

        const reporterA = new PlanProgressReporter(() => {});
        const reporterB = new PlanProgressReporter(() => {});
        const planA = await planIntegratedBundle(sources, "bundle-a", packDir, reporterA);
        const planB = await planIntegratedBundle(
            [...sources].reverse(),
            "bundle-b",
            packDir,
            reporterB,
        );

        const summarize = (plan: typeof planA) =>
            plan.collections.flatMap((collection) =>
                collection.files.map((file) => ({
                    path: file.path,
                    logicalPath: file.logicalPath,
                    logicalSize: file.logicalSize,
                    logicalSha256: file.logicalSha256,
                    packEntries: file.packEntries?.map((entry) => ({
                        path: entry.path,
                        size: entry.size,
                        remoteOffset: entry.remoteOffset,
                        contentSha256: entry.contentSha256,
                    })),
                })),
            );

        expect(summarize(planA)).toEqual(summarize(planB));
    });

    it("hashes files that need a logical hash and records the digest in the plan", async () => {
        // Files below the entry threshold and with kiosk-compatible names need a
        // logical hash to be eligible for packing.
        const { dir, sources } = await makeSourceDir([{ name: "small.txt", content: "tiny" }]);
        const packDir = path.join(dir, "packs");

        const plan = await planIntegratedBundle(
            sources,
            "bundle-x",
            packDir,
            new PlanProgressReporter(() => {}),
        );

        const file = plan.collections
            .flatMap((c) => c.files)
            .find((f) => f.logicalPath === "small.txt");
        expect(file?.logicalSha256).toBe(sha256Of("tiny"));
    });

    it("reports progress for hashing and packing stages including the final frame", async () => {
        const { dir, sources } = await makeSourceDir([
            { name: "x.txt", content: "data-x" },
            { name: "y.txt", content: "data-y" },
        ]);
        const packDir = path.join(dir, "packs");

        const events: Array<{ stage: string; current: number; total: number }> = [];
        const reporter = new PlanProgressReporter((progress) => {
            events.push({ ...progress });
        });

        await planIntegratedBundle(sources, "bundle-p", packDir, reporter);

        const hashingEvents = events.filter((e) => e.stage === "hashing");
        const lastHashing = hashingEvents.at(-1);
        expect(lastHashing).toBeDefined();
        // The final hashing frame must report current === total so the UI can
        // show completion rather than a stale intermediate count.
        expect(lastHashing!.current).toBe(lastHashing!.total);

        const packingEvents = events.filter((e) => e.stage === "packing");
        const lastPacking = packingEvents.at(-1);
        expect(lastPacking?.current).toBe(lastPacking?.total);
    });
});

describe("PlanProgressReporter", () => {
    it("does not emit duplicate progress frames more often than the min interval", () => {
        let clock = 0;
        const nowSpy = vi.spyOn(performance, "now");
        nowSpy.mockImplementation(() => clock);

        const emitted: number[] = [];
        const reporter = new PlanProgressReporter((progress) => {
            emitted.push(progress.current);
        }, 100);

        reporter.report({ stage: "hashing", current: 0, total: 10 }, true);

        // Rapid non-forced updates within the interval should be throttled.
        clock = 10;
        reporter.report({ stage: "hashing", current: 1, total: 10 });
        clock = 20;
        reporter.report({ stage: "hashing", current: 2, total: 10 });
        expect(emitted).toEqual([0]);

        // After the interval elapses, a new frame is emitted.
        clock = 110;
        reporter.report({ stage: "hashing", current: 5, total: 10 });
        expect(emitted).toEqual([0, 5]);

        nowSpy.mockRestore();
    });

    it("always emits the final frame where current equals total", () => {
        const emitted: number[] = [];
        const reporter = new PlanProgressReporter((progress) => {
            emitted.push(progress.current);
        }, 100);

        reporter.report({ stage: "hashing", current: 0, total: 5 }, true);
        // Even immediately after a frame, the final frame (current === total) must pass.
        reporter.report({ stage: "hashing", current: 5, total: 5 });

        expect(emitted).toContain(5);
    });
});

describe("materializePacks", () => {
    it("returns files without pack entries unchanged", async () => {
        const file: UploadSourceFile = {
            path: "direct.bin",
            name: "direct.bin",
            size: 42,
            fsPath: "/source/direct.bin",
            sourceMtimeMs: 1,
        };
        const result = await materializePacks([file]);
        expect(result).toEqual([file]);
    });

    it("returns an empty array when no files are given", async () => {
        const result = await materializePacks([]);
        expect(result).toEqual([]);
    });
});
