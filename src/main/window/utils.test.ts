import path from "node:path";
import { pathToFileURL } from "node:url";

import type { WebFrameMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import { RENDERER_INDEX_PATH, isAppRendererUrl, isTrustedIpcSender } from "./utils";

vi.mock("electron", () => ({ default: { app: { isPackaged: true } } }));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));

const APP_URL = pathToFileURL(RENDERER_INDEX_PATH).href;

describe("isAppRendererUrl", () => {
    it("accepts the packaged renderer entry with a hash route", () => {
        expect(isAppRendererUrl(`${APP_URL}#/settings`)).toBe(true);
    });

    it("rejects other local files even when they mimic the renderer path", () => {
        const lookalike = path.join(path.dirname(RENDERER_INDEX_PATH), "..", "x", "renderer");
        expect(isAppRendererUrl(pathToFileURL(path.join(lookalike, "index.html")).href)).toBe(
            false,
        );
        expect(isAppRendererUrl("file:///Users/me/Downloads/renderer/index.html")).toBe(false);
        expect(isAppRendererUrl("https://example.com/renderer/index.html")).toBe(false);
        expect(isAppRendererUrl("not a url")).toBe(false);
    });
});

describe("isTrustedIpcSender", () => {
    it("accepts only the top-level app renderer frame", () => {
        const top = { url: APP_URL, parent: null } as unknown as WebFrameMain;
        const child = { url: APP_URL, parent: top } as unknown as WebFrameMain;
        const foreign = {
            url: "file:///Users/me/Downloads/renderer/index.html",
            parent: null,
        } as unknown as WebFrameMain;

        expect(isTrustedIpcSender(top)).toBe(true);
        expect(isTrustedIpcSender(child)).toBe(false);
        expect(isTrustedIpcSender(foreign)).toBe(false);
        expect(isTrustedIpcSender(null)).toBe(false);
    });
});
