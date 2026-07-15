import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../logger";

import { withLoggedError } from "./logged-error";

describe("withLoggedError", () => {
    it("sanitizes URL credentials and request data while preserving diagnostic context", async () => {
        const error = new Error("request failed");
        const logError = vi.fn();
        const logger = { error: logError } as unknown as Logger;

        await expect(
            withLoggedError(
                logger,
                "DownloadService:loadCollection",
                {
                    channel: "download:loadCollection",
                    stage: "load",
                    url: "https://user:secret@example.com/share/abc123?token=sensitive#fragment",
                    shareId: "abc123",
                },
                () => {
                    throw error;
                },
            ),
        ).rejects.toBe(error);

        expect(logError).toHaveBeenCalledWith(
            {
                channel: "download:loadCollection",
                stage: "load",
                url: "https://example.com/share/abc123",
                shareId: "abc123",
                message: "request failed",
            },
            "DownloadService:loadCollection",
        );
    });

    it("preserves non-URL context and replaces unparseable URL values", async () => {
        const logError = vi.fn();
        const logger = { error: logError } as unknown as Logger;

        await expect(
            withLoggedError(logger, "test", { url: "not a URL", count: 3 }, () => {
                throw new Error("failed");
            }),
        ).rejects.toThrow("failed");

        expect(logError).toHaveBeenCalledWith(
            { url: "[invalid URL]", count: 3, message: "failed" },
            "test",
        );
    });
});
