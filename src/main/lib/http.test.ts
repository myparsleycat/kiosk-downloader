import ky from "ky";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HTTP } from "./http";

vi.mock("ky", () => ({ default: vi.fn() }));

describe("HTTP.request", () => {
    afterEach(() => {
        vi.mocked(ky).mockReset();
    });

    it("preserves a request-specific fetch implementation", async () => {
        const customFetch = vi.fn(async () => new Response());
        vi.mocked(ky).mockResolvedValueOnce(new Response());

        await new HTTP({} as never).request("https://example.com", { fetch: customFetch });

        expect(ky).toHaveBeenCalledWith(
            "https://example.com",
            expect.objectContaining({ fetch: customFetch }),
        );
    });
});
