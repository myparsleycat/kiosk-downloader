import { BROWSER_EXTENSION_APP_NAME } from "@shared/browser-extension";
import { afterEach, expect, it, vi } from "vitest";

import { getConnection, sendItems } from "./app-client";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it("recognizes an approved extension when Chromium omits Origin from GET requests", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation(async (_input, init) =>
            Response.json({
                app: BROWSER_EXTENSION_APP_NAME,
                version: "1.0.0",
                protocol: 1,
                paired: init?.method === "POST",
            }),
        ),
    );

    expect(await getConnection()).toMatchObject({ state: "connected", version: "1.0.0" });
});

it("waits for approval through short requests before sending links", async () => {
    vi.useFakeTimers();
    let approved = false;
    let result: Awaited<ReturnType<typeof sendItems>> | undefined;
    const getPlatformInfo = vi.fn(async () => ({}));
    vi.stubGlobal("chrome", { runtime: { getPlatformInfo } });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const route = new URL(new Request(input).url).pathname;
        if (route.endsWith("/ping"))
            return Response.json({
                app: BROWSER_EXTENSION_APP_NAME,
                version: "1.0.0",
                protocol: 3,
                paired: approved,
                pairingDenied: false,
            });
        return Response.json({}, { status: route.endsWith("/pair") ? 202 : 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sending = sendItems([{ url: "https://example.com/a.bin", source: "link" }]).then(
        (value) => {
            result = value;
        },
    );
    await vi.advanceTimersByTimeAsync(35_000);
    expect(result).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => new Request(url).url.endsWith("/requests"))).toBe(
        false,
    );
    expect(getPlatformInfo).toHaveBeenCalled();

    approved = true;
    await vi.advanceTimersByTimeAsync(1000);
    await sending;
    expect(result).toEqual({ ok: true });
    expect(
        fetchMock.mock.calls.filter(([url]) => new Request(url).url.endsWith("/requests")),
    ).toHaveLength(1);
});

it("does not send links after pairing is denied", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
            if (new Request(input).url.endsWith("/ping"))
                return Response.json({
                    app: BROWSER_EXTENSION_APP_NAME,
                    version: "1.0.0",
                    protocol: 3,
                    paired: false,
                    pairingDenied: true,
                });
            return Response.json({ error: "pairingDenied" }, { status: 403 });
        }),
    );
    expect(await sendItems([{ url: "https://example.com/a.bin", source: "link" }])).toEqual({
        ok: false,
        reason: "pairingDenied",
    });
});
