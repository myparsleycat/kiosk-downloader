import { describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from "../..";

import { TransferScheduler } from "../transfer-request-pool";
import { SegmentHttpError } from "./kio-api-client";
import { ZipRangeReader, type ZipRangeReaderOptions } from "./zip-range-reader";

function createKd() {
    const requestPool = new TransferScheduler(2);
    const payloadRequest = vi.fn(async (_url: string) => new Response("x"));
    const kd = {
        http: { payloadRequest },
        service: {
            transfer: { requestPool, downloadBandwidth: { take: vi.fn() } },
        },
    } as unknown as KioskDownloader;
    return { kd, payloadRequest };
}

function createReader(kd: KioskDownloader, overrides: Partial<ZipRangeReaderOptions> = {}) {
    return new ZipRangeReader({
        kd,
        segments: [{ type: "cdn", data: new Map([["url", "https://cdn.test/old"]]) }],
        segmentSize: 16,
        fileSize: 16,
        collectionId: "collection",
        signal: new AbortController().signal,
        ...overrides,
    });
}

function expiredResponse() {
    return new Response("<Error><Message>Request has expired</Message></Error>", {
        status: 403,
        headers: { "content-type": "application/xml" },
    });
}

describe("ZipRangeReader expiration recovery", () => {
    it("retries a range read with refreshed descriptors after an expired credential", async () => {
        const { kd, payloadRequest } = createKd();
        payloadRequest
            .mockImplementationOnce(async () => expiredResponse())
            .mockResolvedValue(new Response("abcd"));
        const refreshSegments = vi.fn(async () => [
            { type: "cdn" as const, data: new Map([["url", "https://cdn.test/fresh"]]) },
        ]);
        const reader = createReader(kd, { refreshSegments });

        const bytes = await reader.readUint8Array(0, 4);

        expect(new TextDecoder().decode(bytes)).toBe("abcd");
        expect(refreshSegments).toHaveBeenCalledOnce();
        expect(payloadRequest.mock.calls.map((call) => call[0])).toEqual([
            "https://cdn.test/old",
            "https://cdn.test/fresh",
        ]);
    });

    it("keeps refreshed descriptors for subsequent reads", async () => {
        const { kd, payloadRequest } = createKd();
        payloadRequest
            .mockImplementationOnce(async () => expiredResponse())
            .mockImplementation(async () => new Response("0123456789abcdef"));
        const refreshSegments = vi.fn(async () => [
            { type: "cdn" as const, data: new Map([["url", "https://cdn.test/fresh"]]) },
        ]);
        const reader = createReader(kd, { refreshSegments });

        const first = await reader.readUint8Array(0, 4);
        const second = await reader.readUint8Array(4, 4);

        expect(new TextDecoder().decode(first)).toBe("0123");
        expect(new TextDecoder().decode(second)).toBe("4567");
        expect(refreshSegments).toHaveBeenCalledOnce();
        expect(payloadRequest.mock.calls.map((call) => call[0])).toEqual([
            "https://cdn.test/old",
            "https://cdn.test/fresh",
            "https://cdn.test/fresh",
        ]);
    });

    it("propagates the refresh failure", async () => {
        const { kd, payloadRequest } = createKd();
        payloadRequest.mockImplementation(async () => expiredResponse());
        const refreshSegments = vi.fn(async () => {
            throw new Error("refresh failed");
        });
        const reader = createReader(kd, { refreshSegments });

        await expect(reader.readUint8Array(0, 4)).rejects.toThrow("refresh failed");
        expect(refreshSegments).toHaveBeenCalledOnce();
        expect(payloadRequest).toHaveBeenCalledOnce();
    });

    it("does not retry a still-expired credential after refreshing", async () => {
        const { kd, payloadRequest } = createKd();
        payloadRequest.mockImplementation(async () => expiredResponse());
        const refreshSegments = vi.fn(async () => [
            { type: "cdn" as const, data: new Map([["url", "https://cdn.test/fresh"]]) },
        ]);
        const reader = createReader(kd, { refreshSegments });

        await expect(reader.readUint8Array(0, 4)).rejects.toThrowError(SegmentHttpError);
        expect(refreshSegments).toHaveBeenCalledOnce();
        expect(payloadRequest).toHaveBeenCalledTimes(2);
    });

    it("does not refresh an expired read once the signal is aborted", async () => {
        const { kd, payloadRequest } = createKd();
        const controller = new AbortController();
        payloadRequest.mockImplementation(async () => {
            controller.abort();
            return expiredResponse();
        });
        const refreshSegments = vi.fn(async () => [
            { type: "cdn" as const, data: new Map([["url", "https://cdn.test/fresh"]]) },
        ]);
        const reader = createReader(kd, {
            signal: controller.signal,
            refreshSegments,
        });

        await expect(reader.readUint8Array(0, 4)).rejects.toThrowError(SegmentHttpError);
        expect(refreshSegments).not.toHaveBeenCalled();
    });
});
