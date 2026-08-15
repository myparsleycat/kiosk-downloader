import { encode } from "cbor-x";
import { describe, expect, it, vi } from "vitest";

import { KioApiClient, streamSegmentBytes } from "./kio-api-client";

describe("streamSegmentBytes request pool", () => {
    it("holds a Kiosk download permit until the payload body is consumed", async () => {
        const release = vi.fn();
        const acquire = vi.fn(async () => release);
        const { kd, request, runPayloadStream } = createKioskDownloader(
            acquire,
            Buffer.from("payload"),
        );

        const chunks: Uint8Array[] = [];
        for await (const chunk of streamSegmentBytes(
            kd,
            { type: "cdn", data: new Map([["url", "https://cdn.test/file"]]) },
            0,
            7,
            new AbortController().signal,
            {
                label: "Segment",
                mode: "full",
                collectionId: "collection",
            },
        )) {
            expect(release).not.toHaveBeenCalled();
            chunks.push(chunk);
        }

        expect(Buffer.concat(chunks)).toEqual(Buffer.from("payload"));
        expect(runPayloadStream).toHaveBeenCalledWith(
            {
                collectionId: "collection",
                direction: "download",
                providerId: "kiosk-download",
                signal: expect.any(AbortSignal),
            },
            expect.any(Function),
        );
        expect(release).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith("https://cdn.test/file", expect.any(Object));
    });

    it("does not queue download control calls behind tree walks", async () => {
        const shareId = "abcdefghijklmnopqrstuv";
        const rootId = Buffer.alloc(16, 1);
        let releaseDirectory: () => void = () => undefined;
        const directoryGate = new Promise<void>((resolve) => {
            releaseDirectory = () => resolve();
        });
        const controlRequest = vi.fn(async (url: string) => {
            if (url.endsWith("/collection/get")) {
                return cborResponse(200, {
                    token: "cat",
                    name: "Prepared",
                    root: rootId,
                    segment_size: 16,
                    expires: 4_102_444_800,
                });
            }
            if (url.endsWith("/collection/directory/get")) {
                await directoryGate;
                return cborResponse(200, { files: [], children: [] });
            }
            if (url.endsWith("/collection/file/gets")) {
                return cborResponse(200, {
                    files: [
                        {
                            segments: [
                                {
                                    type: "cdn",
                                    data: new Map([["url", "https://cdn.test/file"]]),
                                },
                            ],
                        },
                    ],
                });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });
        const client = new KioApiClient({
            http: { controlRequest },
        } as never);

        const loading = client.loadCollection({
            url: `https://kio.ac/c/${shareId}`,
        });
        await vi.waitFor(() =>
            expect(
                controlRequest.mock.calls.some(([url]) => String(url).endsWith("/directory/get")),
            ).toBe(true),
        );

        await expect(client.getSegments("aa".repeat(16), "cat")).resolves.toEqual([
            { type: "cdn", data: new Map([["url", "https://cdn.test/file"]]) },
        ]);
        releaseDirectory();
        await loading;
    });
});

function cborResponse(status: number, body: unknown) {
    const raw = Buffer.from(encode(body));
    return {
        status,
        arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    };
}

function createKioskDownloader(acquire: (context: never) => Promise<() => void>, body: Buffer) {
    const request = vi.fn(async () => new Response(body.toString()));
    const runPayloadStream = vi.fn(async function* (
        context: never,
        task: () => AsyncGenerator<Uint8Array>,
    ) {
        const release = await acquire(context);
        try {
            yield* task();
        } finally {
            release();
        }
    });
    const kd = {
        http: {
            payloadRequest: request,
        },
        service: {
            transfer: {
                requestPool: { runPayloadStream },
                downloadBandwidth: { take: vi.fn(async () => undefined) },
            },
        },
    } as never;
    return { kd, request, runPayloadStream };
}
