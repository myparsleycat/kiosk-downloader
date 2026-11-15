import { describe, expect, it, vi } from "vitest";

import type { ControlRequestOptions } from "../../lib/http";

import { requestMegaApi } from "./mega-api";

const OPTIONS = {
    apiBase: "https://g.api.mega.co.nz/cs",
    origin: "https://mega.nz",
    label: "Mega",
};

describe("requestMegaApi", () => {
    it("answers a Hashcash challenge once and resends the command with the solution", async () => {
        const request = vi
            .fn<(url: string, options: ControlRequestOptions) => Promise<Response>>()
            .mockResolvedValueOnce(
                new Response(null, { status: 402, headers: { "X-Hashcash": "1:200:0:token" } }),
            )
            .mockResolvedValueOnce(new Response(JSON.stringify([{ ok: 1 }])));
        const solveHashcash = vi.fn(async () => "1:token:prefix");

        await expect(
            requestMegaApi(http(request), { a: "us" }, { ...OPTIONS, solveHashcash }),
        ).resolves.toEqual({ ok: 1 });
        expect(solveHashcash).toHaveBeenCalledWith("1:200:0:token", undefined);
        expect(new Headers(request.mock.calls[1]?.[1].headers).get("X-Hashcash")).toBe(
            "1:token:prefix",
        );
        const ids = request.mock.calls.map(([url]) => new URL(url).searchParams.get("id"));
        expect(ids[1]).toBe(ids[0]);
    });

    it("retries a transient EAGAIN result", async () => {
        const request = vi
            .fn<(url: string, options: ControlRequestOptions) => Promise<Response>>()
            .mockResolvedValueOnce(new Response("-3"))
            .mockResolvedValueOnce(new Response(JSON.stringify([{ ok: 1 }])));

        await expect(requestMegaApi(http(request), { a: "g" }, OPTIONS)).resolves.toEqual({
            ok: 1,
        });
        expect(request).toHaveBeenCalledTimes(2);
    });
});

function http(request: (url: string, options: ControlRequestOptions) => Promise<Response>) {
    return {
        consumeControlResponse: async <T>(
            url: string,
            options: ControlRequestOptions,
            consume: (response: Response) => Promise<T>,
        ) => consume(await request(url, options)),
    };
}
