import { describe, expect, it } from "vitest";

import { allocateUniqueName } from "./unique-name";

describe("allocateUniqueName", () => {
    it("skips names already taken while continuing from the last suffix", () => {
        const used = new Map<string, number>();
        const names = ["file.txt", "file (3).txt", "FILE.txt", "file.txt", "file.txt"].map((name) =>
            allocateUniqueName(name, used),
        );

        expect(names).toEqual([
            "file.txt",
            "file (3).txt",
            "FILE (2).txt",
            "file (4).txt",
            "file (5).txt",
        ]);
        expect(used.get("file.txt")).toBe(6);
    });

    it("appends the suffix after the full name when extensions are not kept", () => {
        const used = new Map<string, number>();
        expect(["a.b", "a.b"].map((name) => allocateUniqueName(name, used, false))).toEqual([
            "a.b",
            "a.b (2)",
        ]);
    });
});
