import { describe, expect, it } from "vitest";

import {
    MAX_HTTP_ERROR_PREVIEW_CHARS,
    MAX_HTTP_ERROR_READ_BYTES,
    cborHttpError,
    formatHttpError,
    snapshotDecodedBody,
    snapshotFailedResponse,
} from "./http-error";

describe("snapshotFailedResponse", () => {
    it("collapses text bodies and keeps allowlisted headers", async () => {
        const snapshot = await snapshotFailedResponse(
            new Response("error   code:\n1020", {
                status: 403,
                statusText: "Forbidden",
                headers: {
                    "content-type": "text/plain",
                    "cf-ray": "ray-1",
                    "set-cookie": "secret=1",
                    authorization: "Bearer nope",
                },
            }),
        );

        expect(snapshot).toMatchObject({
            status: 403,
            statusText: "Forbidden",
            contentType: "text/plain",
            bodyKind: "text",
            bodyPreview: "error code: 1020",
            headers: { "content-type": "text/plain", "cf-ray": "ray-1" },
        });
        expect(snapshot.headers["set-cookie"]).toBeUndefined();
        expect(formatHttpError("Transfer CDN", snapshot)).toBe(
            "Transfer CDN HTTP 403: error code: 1020 cf-ray=ray-1",
        );
    });

    it("compacts JSON and classifies HTML", async () => {
        const json = await snapshotFailedResponse(
            new Response(JSON.stringify({ code: "denied", message: "no" }), {
                status: 400,
                headers: { "content-type": "application/json" },
            }),
        );
        expect(json.bodyKind).toBe("json");
        expect(json.bodyPreview).toBe('{"code":"denied","message":"no"}');

        const html = await snapshotFailedResponse(
            new Response("<html>\n<title>Blocked</title>\n</html>", {
                status: 502,
                headers: { "content-type": "text/html" },
            }),
        );
        expect(html.bodyKind).toBe("html");
        expect(html.bodyPreview).toBe("<html> <title>Blocked</title> </html>");
    });

    it("omits binary bodies and records type and length", async () => {
        const snapshot = await snapshotFailedResponse(
            new Response(Buffer.from([0, 1, 2, 3]), {
                status: 500,
                headers: { "content-type": "application/octet-stream", "content-length": "4" },
            }),
        );
        expect(snapshot.bodyKind).toBe("binary");
        expect(snapshot.bodyPreview).toBe("");
        expect(snapshot.bodyBytes).toBe(4);
        expect(formatHttpError("Segment", snapshot)).toBe(
            "Segment HTTP 500 [application/octet-stream 4B]",
        );
    });

    it("treats NUL bytes as binary even when the content type is textual", async () => {
        const snapshot = await snapshotFailedResponse(
            new Response(Buffer.from("ok\0no"), {
                status: 500,
                headers: { "content-type": "text/plain" },
            }),
        );
        expect(snapshot.bodyKind).toBe("binary");
        expect(snapshot.bodyPreview).toBe("");
    });

    it("caps the bytes read and the preview length", async () => {
        const snapshot = await snapshotFailedResponse(
            new Response("x".repeat(MAX_HTTP_ERROR_READ_BYTES + 64), {
                status: 503,
                headers: { "content-type": "text/plain" },
            }),
        );
        expect(snapshot.bodyBytes).toBe(MAX_HTTP_ERROR_READ_BYTES);
        expect(snapshot.bodyPreview).toHaveLength(MAX_HTTP_ERROR_PREVIEW_CHARS);
    });

    it("strips query data from Location and ignores empty bodies", async () => {
        const redirect = await snapshotFailedResponse(
            new Response(null, {
                status: 302,
                headers: { location: "https://cdn.example/path?token=secret#frag" },
            }),
        );
        expect(redirect.bodyKind).toBe("empty");
        expect(redirect.headers.location).toBe("https://cdn.example/path");
        expect(formatHttpError("Workupload page", redirect)).toBe(
            "Workupload page HTTP 302 location=https://cdn.example/path",
        );
    });

    it("falls back to a headers-only snapshot when the body read fails", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("par"));
                controller.error(new Error("terminated"));
            },
        });
        const snapshot = await snapshotFailedResponse(
            new Response(stream, {
                status: 403,
                statusText: "Forbidden",
                headers: { "content-type": "text/plain", "cf-ray": "ray-1" },
            }),
        );

        expect(snapshot).toMatchObject({
            status: 403,
            statusText: "Forbidden",
            contentType: "text/plain",
            bodyKind: "empty",
            bodyPreview: "",
            bodyBytes: 0,
            headers: { "content-type": "text/plain", "cf-ray": "ray-1" },
        });
        expect(formatHttpError("Transfer CDN", snapshot)).toBe(
            "Transfer CDN HTTP 403 cf-ray=ray-1",
        );
    });
});

describe("snapshotDecodedBody", () => {
    it("stringifies decoded objects and falls back to raw text", () => {
        const decoded = snapshotDecodedBody(403, {
            code: "collection:not_found",
            message: "gone",
        });
        expect(decoded.bodyKind).toBe("json");
        expect(decoded.bodyPreview).toBe('{"code":"collection:not_found","message":"gone"}');
        expect(formatHttpError("file/gets failed:", decoded)).toBe(
            'file/gets failed: HTTP 403: {"code":"collection:not_found","message":"gone"}',
        );

        const raw = snapshotDecodedBody(
            502,
            null,
            Buffer.from("<html>cf 1020</html>"),
            new Headers({ "content-type": "text/html" }),
        );
        expect(raw.bodyKind).toBe("html");
        expect(raw.bodyPreview).toContain("cf 1020");
    });
});

describe("cborHttpError", () => {
    it("formats decoded CBOR responses into an error", () => {
        const error = cborHttpError("file/gets failed:", {
            status: 403,
            raw: Buffer.from('{"code":"collection:not_found"}'),
            body: { code: "collection:not_found" },
        });
        expect(error).toBeInstanceOf(Error);
        expect(error.status).toBe(403);
        expect(error.message).toBe('file/gets failed: HTTP 403: {"code":"collection:not_found"}');
    });
});
