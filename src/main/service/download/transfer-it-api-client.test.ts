import { describe, expect, it, vi } from "vitest";

import { TimeoutError, type ControlRequestOptions } from "../../lib/http";
import { TransferItApiClient } from "./transfer-it-api-client";

describe("TransferItApiClient control cancellation", () => {
    it("forwards cancellation to download URL lookup", async () => {
        const controller = new AbortController();
        const request = vi.fn(async (_url: string, _options: ControlRequestOptions) =>
            downloadResponse(),
        );
        await expect(
            controlClient(request).getDownloadUrl("share", "file", undefined, controller.signal),
        ).resolves.toEqual({ url: "https://cdn.test/file", size: 42 });
        expect(request.mock.calls[0]?.[1].signal).toBe(controller.signal);
    });

    it("does not send a URL lookup canceled while waiting for a control slot", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const request = vi.fn(async () => {
            await gate;
            return downloadResponse();
        });
        const client = controlClient(request);
        const running = Array.from({ length: 4 }, () => client.getDownloadUrl("share", "file"));
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
        const controller = new AbortController();
        const queued = expect(
            client.getDownloadUrl("share", "queued", undefined, controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        controller.abort();
        release();
        await Promise.all(running);
        await queued;
        expect(request).toHaveBeenCalledTimes(4);
    });

    it.each([
        new DOMException("Stopped", "AbortError"),
        new TimeoutError(new Request("https://bt7.api.mega.co.nz")),
    ])("preserves body read failure $name instead of reporting malformed JSON", async (error) => {
        const request = vi.fn(
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.error(error);
                        },
                    }),
                ),
        );
        await expect(controlClient(request).getDownloadUrl("share", "file")).rejects.toBe(error);
    });

    it("includes API error bodies in HTTP failures", async () => {
        await expect(
            controlClient(
                async () =>
                    new Response(JSON.stringify({ err: "over quota" }), {
                        status: 500,
                        headers: { "content-type": "application/json" },
                    }),
            ).getDownloadUrl("share", "file"),
        ).rejects.toThrow('Transfer API HTTP 500: {"err":"over quota"}');
    });

    it("keeps the Hashcash 402 control message", async () => {
        await expect(
            controlClient(async () => new Response("pay", { status: 402 })).getDownloadUrl(
                "share",
                "file",
            ),
        ).rejects.toThrow("Transfer API requires Hashcash challenge (HTTP 402).");
    });

    it("still reports genuinely malformed JSON", async () => {
        await expect(
            controlClient(async () => new Response("invalid")).getDownloadUrl("share", "file"),
        ).rejects.toThrow("Transfer API bad JSON:");
    });

    it("rejects a response that finishes after the caller canceled", async () => {
        const controller = new AbortController();
        const response = downloadResponse();
        vi.spyOn(response, "text").mockImplementation(async () => {
            controller.abort();
            return '[{"g":"https://cdn.test/file"}]';
        });
        await expect(
            controlClient(async () => response).getDownloadUrl(
                "share",
                "file",
                undefined,
                controller.signal,
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
    });
});

function downloadResponse() {
    return new Response(JSON.stringify([{ g: "https://cdn.test/file", s: 42 }]));
}

function controlClient(
    request: (url: string, options: ControlRequestOptions) => Promise<Response>,
) {
    return new TransferItApiClient({
        http: {
            consumeControlResponse: async <T>(
                url: string,
                options: ControlRequestOptions,
                consume: (response: Response) => Promise<T>,
            ) => consume(await request(url, options)),
        },
    } as never);
}
