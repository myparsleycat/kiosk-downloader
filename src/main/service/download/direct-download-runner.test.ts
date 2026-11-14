import os from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TransferFileRegistration } from "./transfer-chunk-pool";
import type { DownloadChunkRow } from "./types";

import { TransferScheduler } from "../transfer-request-pool";
import { DirectDownloadRunner } from "./direct-download-runner";
import { DirectHttpClient } from "./direct-http-client";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fse.remove(dir)));
});

async function createHarness(options: {
    rangeSupported: boolean;
    payloadRequest: ReturnType<typeof vi.fn>;
    poolOutcome?: "paused";
    meta?: Record<string, unknown>;
    size?: number;
    downloadedBytes?: number;
    chunkStatus?: DownloadChunkRow["status"];
}) {
    const dir = await fse.mkdtemp(path.join(os.tmpdir(), "direct-runner-"));
    tempDirs.push(dir);
    const meta = { rangeSupported: options.rangeSupported, etag: '"v1"', ...options.meta };
    const collection = {
        id: "collection",
        shareId: "example.com",
        sourceUrl: "https://example.com/file.bin",
        requestHeadersJson: JSON.stringify({ cookie: "a=b" }),
        pauseReasonJson: null,
    };
    const file = {
        id: "file",
        collectionId: "collection",
        size: options.size ?? 4,
        sourceMetaJson: JSON.stringify(meta),
        downloadedBytes: options.downloadedBytes ?? 0,
        status: "downloading",
    };
    const chunk = (): DownloadChunkRow => ({
        collectionId: "collection",
        fileId: "file",
        chunkIndex: 0,
        offset: 0,
        size: file.size,
        status: chunkStatus,
        downloadedBytes: file.downloadedBytes,
        attempts: 0,
        updatedAt: "",
        error: null,
    });
    let chunkStatus: DownloadChunkRow["status"] = options.chunkStatus ?? "pending";
    const repository = {
        listChunks: vi.fn(() => (file.size === 0 ? [] : [chunk()])),
        syncFileDownloadedBytes: vi.fn(),
        getFile: vi.fn(() => file),
        getCollection: vi.fn(() => collection),
        resetFileProgress: vi.fn(() => {
            chunkStatus = "pending";
            file.downloadedBytes = 0;
        }),
        updateDirectRemote: vi.fn(
            (_fileId: string, remote: { size: number; sourceMetaJson: string }) => {
                file.size = remote.size;
                file.sourceMetaJson = remote.sourceMetaJson;
            },
        ),
        markFileStatus: vi.fn(),
        hasErroredChunk: vi.fn(() => false),
    };
    const kd = {
        http: { payloadRequest: options.payloadRequest },
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
        service: {
            transfer: {
                requestPool: new TransferScheduler(8),
                downloadBandwidth: { take: vi.fn(async () => undefined) },
            },
        },
    };
    // Minimal stand-in for TransferChunkPool: drain each chunk through the source once and,
    // like the real pool, abort the registration's controller when the file fails.
    const register = vi.fn(async (registration: TransferFileRegistration) => {
        if (options.poolOutcome) {
            return options.poolOutcome;
        }
        for (const pending of registration.chunks) {
            try {
                for await (const _ of registration.source.openRange(
                    pending,
                    pending.downloadedBytes,
                    registration.controller.signal,
                    () => undefined,
                    () => undefined,
                )) {
                    // consume
                }
            } catch (error) {
                if (registration.source.isFatal?.(error)) {
                    registration.controller.abort();
                    return "failed" as const;
                }
                throw error;
            }
        }
        chunkStatus = "completed";
        return "completed" as const;
    });
    const finalizeFile = vi.fn(async () => undefined);
    const runner = new DirectDownloadRunner({
        kd: kd as never,
        api: new DirectHttpClient(kd as never),
        repository: repository as never,
        transferPool: { register } as never,
        runControl: (<T>(task: () => Promise<T>) => task()) as never,
        getPartPath: () => path.join(dir, "file.bin.part"),
        validateCompletedChunks: vi.fn(async () => undefined),
        finalizeFile,
        markProgress: vi.fn(),
        emitUpdate: vi.fn(async () => undefined),
    });
    const run = () =>
        runner.runFile({
            collection: collection as never,
            file: file as never,
            controller: new AbortController(),
            maxChunkRetries: 0,
            priority: 0,
            startedAt: 0,
            collectionStartedAt: 0,
        });
    return { run, repository, register, finalizeFile, partPath: path.join(dir, "file.bin.part") };
}

const partial = (body: string, etag = '"v1"') =>
    new Response(body, {
        status: 206,
        headers: { "content-range": `bytes 0-${body.length - 1}/${body.length}`, etag },
    });
const probe = (size: number, etag: string) =>
    new Response("x", {
        status: 206,
        headers: { "content-range": `bytes 0-0/${size}`, etag },
    });

describe("DirectDownloadRunner", () => {
    it("downloads a file that grew after it was recorded as empty", async () => {
        const payloadRequest = vi
            .fn()
            .mockResolvedValueOnce(probe(4, '"v2"'))
            .mockResolvedValueOnce(partial("abcd", '"v2"'));
        const harness = await createHarness({ rangeSupported: true, payloadRequest, size: 0 });

        await harness.run();

        expect(harness.repository.updateDirectRemote).toHaveBeenCalledWith(
            "file",
            expect.objectContaining({ size: 4 }),
        );
        expect(harness.register.mock.calls[0]?.[0].chunks).toMatchObject([
            { offset: 0, size: 4, downloadedBytes: 0 },
        ]);
        expect(new Headers(payloadRequest.mock.calls[1]![1].headers).get("range")).toBe(
            "bytes=0-3",
        );
        expect(harness.finalizeFile).toHaveBeenCalledOnce();
    });

    it("finalizes a file that is still empty after revalidation", async () => {
        const payloadRequest = vi.fn().mockResolvedValue(
            new Response(null, {
                status: 416,
                headers: { "content-range": "bytes */0", etag: '"v1"' },
            }),
        );
        const harness = await createHarness({ rangeSupported: true, payloadRequest, size: 0 });

        await harness.run();

        expect(payloadRequest).toHaveBeenCalledOnce();
        expect(harness.register).not.toHaveBeenCalled();
        expect(harness.finalizeFile).toHaveBeenCalledOnce();
    });

    it("discards unvalidated progress when probing fails without a validator", async () => {
        const payloadRequest = vi
            .fn()
            .mockRejectedValueOnce(new Error("probe failed"))
            .mockImplementationOnce(async (_url: string, init: { headers: HeadersInit }) => {
                const resumed = new Headers(init.headers).get("range") === "bytes=2-3";
                return new Response(resumed ? "cd" : "abcd", {
                    status: 206,
                    headers: { "content-range": resumed ? "bytes 2-3/4" : "bytes 0-3/4" },
                });
            });
        const harness = await createHarness({
            rangeSupported: true,
            payloadRequest,
            downloadedBytes: 2,
            meta: { etag: undefined },
        });
        await fse.writeFile(harness.partPath, "ab");
        await fse.writeFile(`${harness.partPath}.crc`, "old!");

        await harness.run();

        expect(harness.repository.resetFileProgress).toHaveBeenCalledWith("file");
        expect(new Headers(payloadRequest.mock.calls[1]![1].headers).get("range")).toBe(
            "bytes=0-3",
        );
        expect(await fse.readFile(harness.partPath, "utf8")).toBe("");
        expect(await fse.readFile(`${harness.partPath}.crc`, "utf8")).toBe("");
        expect(harness.finalizeFile).toHaveBeenCalledOnce();
    });

    it.each([{ etag: '"v1"' }, { etag: undefined, lastModified: "Mon" }])(
        "keeps progress on probe failure with validator %j",
        async (meta) => {
            const payloadRequest = vi
                .fn()
                .mockRejectedValueOnce(new Error("probe failed"))
                .mockResolvedValueOnce(
                    new Response("cd", {
                        status: 206,
                        headers: {
                            "content-range": "bytes 2-3/4",
                            etag: '"v1"',
                            "last-modified": "Mon",
                        },
                    }),
                );
            const harness = await createHarness({
                rangeSupported: true,
                payloadRequest,
                downloadedBytes: 2,
                meta,
            });

            await harness.run();

            expect(harness.repository.resetFileProgress).not.toHaveBeenCalled();
            const headers = new Headers(payloadRequest.mock.calls[1]![1].headers);
            expect(headers.get("range")).toBe("bytes=2-3");
            expect(headers.get("if-range")).toBe(meta.etag ?? meta.lastModified);
        },
    );

    it("keeps progress after a successful probe without validators", async () => {
        const payloadRequest = vi
            .fn()
            .mockResolvedValueOnce(probe(4, ""))
            .mockResolvedValueOnce(
                new Response("cd", { status: 206, headers: { "content-range": "bytes 2-3/4" } }),
            );
        const harness = await createHarness({
            rangeSupported: true,
            payloadRequest,
            downloadedBytes: 2,
            meta: { etag: undefined },
        });

        await harness.run();

        expect(harness.repository.resetFileProgress).not.toHaveBeenCalled();
        expect(new Headers(payloadRequest.mock.calls[1]![1].headers).get("range")).toBe(
            "bytes=2-3",
        );
    });

    it("finalizes complete chunks after revalidation without fetching them again", async () => {
        const payloadRequest = vi.fn().mockResolvedValue(probe(4, '"v1"'));
        const harness = await createHarness({
            rangeSupported: true,
            payloadRequest,
            chunkStatus: "completed",
            downloadedBytes: 4,
        });

        await harness.run();

        expect(payloadRequest).toHaveBeenCalledOnce();
        expect(harness.register).not.toHaveBeenCalled();
        expect(harness.finalizeFile).toHaveBeenCalledOnce();
    });

    it("sends If-Range and request headers, then finalizes", async () => {
        const payloadRequest = vi.fn(async (_url: string, _init: { headers: HeadersInit }) =>
            partial("abcd"),
        );
        const harness = await createHarness({ rangeSupported: true, payloadRequest });

        await harness.run();

        const headers = new Headers(payloadRequest.mock.calls[0]![1].headers);
        expect(headers.get("range")).toBe("bytes=0-3");
        expect(headers.get("if-range")).toBe('"v1"');
        expect(headers.get("cookie")).toBe("a=b");
        expect(harness.finalizeFile).toHaveBeenCalledOnce();
    });

    it("resets and restarts once when the remote file changed", async () => {
        const payloadRequest = vi
            .fn()
            .mockResolvedValueOnce(new Response("new!", { status: 200 }))
            .mockResolvedValueOnce(probe(4, '"v2"'))
            .mockResolvedValueOnce(partial("efgh", '"v2"'));
        const harness = await createHarness({ rangeSupported: true, payloadRequest });

        await harness.run();

        expect(harness.repository.resetFileProgress).toHaveBeenCalledWith("file");
        expect(harness.repository.updateDirectRemote).toHaveBeenCalledWith(
            "file",
            expect.objectContaining({ size: 4 }),
        );
        expect(new Headers(payloadRequest.mock.calls[2]![1].headers).get("if-range")).toBe('"v2"');
        expect(harness.finalizeFile).toHaveBeenCalledOnce();
    });

    it("keeps the cookie on the source origin when chunks reuse a cross-origin final URL", async () => {
        const payloadRequest = vi.fn(async (_url: string, _init: { headers: HeadersInit }) =>
            partial("abcd"),
        );
        const harness = await createHarness({
            rangeSupported: true,
            payloadRequest,
            meta: { finalUrl: "https://cdn.example.net/signed?sig=1" },
        });

        await harness.run();

        expect(payloadRequest.mock.calls[0]![0]).toBe("https://cdn.example.net/signed?sig=1");
        expect(new Headers(payloadRequest.mock.calls[0]![1].headers).get("cookie")).toBeNull();
    });

    it("treats a changed Last-Modified on a 206 as a remote change", async () => {
        const stale = new Response("abcd", {
            status: 206,
            headers: { "content-range": "bytes 0-3/4", "last-modified": "Tue" },
        });
        const fresh = new Response("x", {
            status: 206,
            headers: { "content-range": "bytes 0-0/4", "last-modified": "Tue" },
        });
        const payloadRequest = vi
            .fn()
            .mockResolvedValueOnce(stale)
            .mockResolvedValueOnce(fresh)
            .mockResolvedValueOnce(
                new Response("efgh", {
                    status: 206,
                    headers: { "content-range": "bytes 0-3/4", "last-modified": "Tue" },
                }),
            );
        const harness = await createHarness({
            rangeSupported: true,
            payloadRequest,
            meta: { etag: undefined, lastModified: "Mon" },
        });

        await harness.run();

        expect(harness.repository.resetFileProgress).toHaveBeenCalledWith("file");
        expect(harness.finalizeFile).toHaveBeenCalledOnce();
    });

    it("gives up when the remote keeps changing", async () => {
        const payloadRequest = vi
            .fn()
            .mockResolvedValueOnce(new Response("new!", { status: 200 }))
            .mockResolvedValueOnce(probe(4, '"v2"'))
            .mockResolvedValueOnce(new Response("new!", { status: 200 }));
        const harness = await createHarness({ rangeSupported: true, payloadRequest });

        await expect(harness.run()).rejects.toThrow("계속 변경");
        expect(harness.finalizeFile).not.toHaveBeenCalled();
    });

    it("discards progress when a non-Range download is paused", async () => {
        const harness = await createHarness({
            rangeSupported: false,
            payloadRequest: vi.fn(),
            poolOutcome: "paused",
        });

        await harness.run();

        expect(harness.repository.resetFileProgress).toHaveBeenCalledWith("file");
        expect(harness.repository.markFileStatus).toHaveBeenCalledWith("file", "pending");
    });
});
