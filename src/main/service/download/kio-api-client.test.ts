import { describe, expect, it, vi } from "vitest";

import { streamSegmentBytes } from "./kio-api-client";

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
});

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
