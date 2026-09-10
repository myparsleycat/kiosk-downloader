import { encode } from "cbor-x";
import { describe, expect, it, vi } from "vitest";

import type { HttpErrorSnapshot } from "../../lib/http-error";

import { TimeoutError, type ControlRequestOptions } from "../../lib/http";
import {
    isSegmentTokenExpired,
    KioApiClient,
    SegmentHttpError,
    streamSegmentBytes,
} from "./kio-api-client";

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
            http: {
                consumeControlResponse: async <T>(
                    url: string,
                    _options: unknown,
                    consume: (response: ReturnType<typeof cborResponse>) => Promise<T>,
                ) => consume(await controlRequest(url)),
            },
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

describe("KioApiClient control cancellation", () => {
    it("forwards cancellation to token refresh and segment lookup", async () => {
        const controller = new AbortController();
        const request = vi.fn(async (url: string, _options: ControlRequestOptions) =>
            url.endsWith("/collection/get")
                ? cborResponse(200, {
                      token: "cat",
                      name: "Prepared",
                      root: Buffer.alloc(16, 1),
                      segment_size: 16,
                      expires: 4_102_444_800,
                  })
                : segmentResponse(),
        );
        const client = controlClient(request);
        await expect(
            client.refreshCollectionToken(
                { shareId: "abcdefghijklmnopqrstuv", passwordPlain: null } as never,
                controller.signal,
            ),
        ).resolves.toMatchObject({ cat: "cat" });
        await client.getSegments("aa".repeat(16), "cat", controller.signal);
        expect(request).toHaveBeenCalledTimes(2);
        for (const [, options] of request.mock.calls)
            expect(options.signal).toBe(controller.signal);
    });

    it("does not send an operation canceled while waiting for a control slot", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const request = vi.fn(async () => {
            await gate;
            return segmentResponse();
        });
        const client = controlClient(request);
        const running = Array.from({ length: 4 }, () => client.getSegments("aa".repeat(16), "cat"));
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
        const controller = new AbortController();
        const queued = expect(
            client.getSegments("bb".repeat(16), "cat", controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        controller.abort();
        try {
            await queued;
            expect(request).toHaveBeenCalledTimes(4);
        } finally {
            release();
            await Promise.all(running);
        }
        expect(request).toHaveBeenCalledTimes(4);
    });

    it.each([
        new DOMException("Stopped", "AbortError"),
        new TimeoutError(new Request("https://api.kio.ac")),
    ])("preserves body read failure $name", async (error) => {
        const client = controlClient(async () => ({
            status: 200,
            arrayBuffer: async () => {
                throw error;
            },
        }));
        await expect(client.getSegments("aa".repeat(16), "cat")).rejects.toBe(error);
    });
});

describe("KioApiClient HTTP errors", () => {
    it("preserves the status of a rejected CAT for token refresh recovery", async () => {
        const client = controlClient(async () =>
            cborResponse(401, { code: "auth:invalid_token", message: "invalid token" }),
        );
        await expect(client.getSegments("aa".repeat(16), "invalid-cat")).rejects.toMatchObject({
            name: "CborHttpError",
            status: 401,
            message:
                'file/gets failed: HTTP 401: {"code":"auth:invalid_token","message":"invalid token"}',
        });
    });

    it("includes decoded error bodies in file/gets failures", async () => {
        const client = controlClient(async () =>
            cborResponse(403, { code: "collection:not_found", message: "gone" }),
        );
        await expect(client.getSegments("aa".repeat(16), "cat")).rejects.toThrow(
            'file/gets failed: HTTP 403: {"code":"collection:not_found","message":"gone"}',
        );
    });

    it("includes decoded error bodies in collection/get failures", async () => {
        const shareId = "abcdefghijklmnopqrstuv";
        const client = controlClient(async () =>
            cborResponse(500, { code: "internal", message: "boom" }),
        );
        await expect(client.loadCollection({ url: `https://kio.ac/c/${shareId}` })).rejects.toThrow(
            'collection/get failed: HTTP 500: {"code":"internal","message":"boom"}',
        );
    });

    it("includes CDN error page text in segment stream failures", async () => {
        const release = vi.fn();
        const acquire = vi.fn(async () => release);
        const { kd } = createKioskDownloader(
            acquire,
            Buffer.from("payload"),
            new Response("<html>error code: 1020</html>", {
                status: 403,
                headers: { "content-type": "text/html", "cf-ray": "ray-1" },
            }),
        );

        const failure = async () => {
            for await (const _chunk of streamSegmentBytes(
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
            }
        };
        const error = await failure().then(
            () => null,
            (caught) => caught,
        );

        expect(error).toBeInstanceOf(SegmentHttpError);
        expect(error).toMatchObject({ status: 403 });
        expect(String((error as Error)?.message)).toMatch(
            /Segment HTTP 403: .*error code: 1020.*cf-ray=ray-1/,
        );
        expect(isSegmentTokenExpired(error)).toBe(false);
        expect(release).toHaveBeenCalledOnce();
    });
});

describe("isSegmentTokenExpired", () => {
    const snapshot = (overrides: Partial<HttpErrorSnapshot> = {}): HttpErrorSnapshot => ({
        status: 403,
        statusText: "",
        contentType: "application/xml",
        contentLength: null,
        headers: {},
        bodyKind: "html",
        bodyPreview: "",
        bodyBytes: 0,
        ...overrides,
    });

    it("recognizes an explicitly expired credential body on 403", () => {
        expect(
            isSegmentTokenExpired(
                new SegmentHttpError(
                    "Segment HTTP 403: Request has expired",
                    403,
                    snapshot({ bodyPreview: "Request has expired" }),
                ),
            ),
        ).toBe(true);
    });

    it("recognizes x-amz expiration headers on 403", () => {
        expect(
            isSegmentTokenExpired(
                new SegmentHttpError(
                    "Segment HTTP 403",
                    403,
                    snapshot({ headers: { "x-amz-error-code": "ExpiredToken" } }),
                ),
            ),
        ).toBe(true);
    });

    it("treats a 401 as an expired credential", () => {
        expect(
            isSegmentTokenExpired(
                new SegmentHttpError("Segment HTTP 401", 401, snapshot({ status: 401 })),
            ),
        ).toBe(true);
    });

    it("rejects non-expiration 403s and other statuses", () => {
        expect(
            isSegmentTokenExpired(
                new SegmentHttpError(
                    "Segment HTTP 403: error code: 1020",
                    403,
                    snapshot({ bodyPreview: "error code: 1020" }),
                ),
            ),
        ).toBe(false);
        expect(
            isSegmentTokenExpired(
                new SegmentHttpError(
                    "Segment HTTP 404",
                    404,
                    snapshot({ status: 404, bodyPreview: "Request has expired" }),
                ),
            ),
        ).toBe(false);
        expect(isSegmentTokenExpired(new Error("plain"))).toBe(false);
    });
});

function segmentResponse() {
    return cborResponse(200, {
        files: [{ segments: [{ type: "cdn", data: new Map([["url", "https://cdn.test/file"]]) }] }],
    });
}

function controlClient(
    request: (
        url: string,
        options: ControlRequestOptions,
    ) => Promise<ReturnType<typeof cborResponse>>,
) {
    return new KioApiClient({
        http: {
            consumeControlResponse: async <T>(
                url: string,
                options: ControlRequestOptions,
                consume: (response: ReturnType<typeof cborResponse>) => Promise<T>,
            ) => consume(await request(url, options)),
        },
    } as never);
}

function cborResponse(status: number, body: unknown) {
    const raw = Buffer.from(encode(body));
    return {
        status,
        arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    };
}

function createKioskDownloader(
    acquire: (context: never) => Promise<() => void>,
    body: Buffer,
    response?: Response,
) {
    const request = vi.fn(async () => response ?? new Response(body.toString()));
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
