import { describe, expect, it } from "vitest";

import { normalizeCollectionPasswordList } from "./setting";

describe("collection password settings", () => {
    it("preserves password whitespace exactly", () => {
        expect(normalizeCollectionPasswordList([" password", "password ", " "])).toEqual([
            " password",
            "password ",
            " ",
        ]);
    });

    it("removes only empty and exact duplicate values", () => {
        expect(normalizeCollectionPasswordList(["", "password", "password", " password"])).toEqual([
            "password",
            " password",
        ]);
    });
});
