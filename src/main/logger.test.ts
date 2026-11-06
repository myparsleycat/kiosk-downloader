import { describe, expect, it, vi } from "vitest";

import { toLogEntry } from "./logger";

vi.mock("electron", () => ({ app: { whenReady: () => new Promise(() => {}) } }));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));

describe("toLogEntry", () => {
    it("keeps the message and stack of a top-level error", () => {
        const entry = toLogEntry(new Error("boom"), "App");

        expect(entry.msg).toBe("[App]");
        expect(entry.fields?.err).toMatchObject({
            type: "Error",
            message: "boom",
            stack: expect.stringContaining("boom"),
        });
    });

    it("serializes errors nested in a context object instead of logging {}", () => {
        const entry = toLogEntry({ channel: "x", error: new TypeError("bad") }, "IPC");

        expect(entry.fields).toMatchObject({
            channel: "x",
            error: { type: "TypeError", message: "bad" },
        });
    });

    it("degrades circular and BigInt values instead of dropping the line", () => {
        const circular: Record<string, unknown> = { id: 1 };
        circular.self = circular;

        expect(toLogEntry({ size: 10n }).fields).toEqual({ size: "10" });
        expect(toLogEntry(circular, "Loop")).toMatchObject({
            msg: "[Loop]",
            fields: { unserializable: "id,self" },
        });
    });

    it("prefixes primitive messages with the location", () => {
        expect(toLogEntry("started", "App")).toEqual({ msg: "[App] started" });
        expect(toLogEntry(undefined, "App")).toEqual({ msg: "[App]" });
    });

    it("snapshots the context so later mutation does not change the entry", () => {
        const context = { stage: "load" };
        const entry = toLogEntry(context, "Svc");
        context.stage = "write";

        expect(entry.fields).toEqual({ stage: "load" });
    });
});
