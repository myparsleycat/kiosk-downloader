import { describe, expect, it } from "vitest";

import {
    isBulkPausable,
    isBulkStartable,
    runBulkItemActions,
    shouldConfirmBulkRemove,
} from "./bulk-transfer";

describe("isBulkStartable", () => {
    it.each(["paused", "queued", "error"] as const)("%s is startable", (status) => {
        expect(isBulkStartable(status)).toBe(true);
    });

    it.each(["downloading", "inflating", "uploading", "completed", "expired"] as const)(
        "%s is not startable",
        (status) => {
            expect(isBulkStartable(status)).toBe(false);
        },
    );
});

describe("isBulkPausable", () => {
    it.each(["downloading", "inflating", "queued"] as const)(
        "download %s is pausable",
        (status) => {
            expect(isBulkPausable("download", status)).toBe(true);
        },
    );

    it.each(["paused", "error", "completed", "expired", "uploading"] as const)(
        "download %s is not pausable",
        (status) => {
            expect(isBulkPausable("download", status)).toBe(false);
        },
    );

    it.each(["uploading", "queued"] as const)("upload %s is pausable", (status) => {
        expect(isBulkPausable("upload", status)).toBe(true);
    });

    it.each(["paused", "error", "completed", "expired", "downloading", "inflating"] as const)(
        "upload %s is not pausable",
        (status) => {
            expect(isBulkPausable("upload", status)).toBe(false);
        },
    );
});

describe("shouldConfirmBulkRemove", () => {
    it("requires confirmation when any item is incomplete", () => {
        expect(shouldConfirmBulkRemove([{ status: "completed" }, { status: "paused" }])).toBe(true);
    });

    it("skips confirmation when every item is completed", () => {
        expect(shouldConfirmBulkRemove([{ status: "completed" }, { status: "completed" }])).toBe(
            false,
        );
    });

    it("skips confirmation for an empty list", () => {
        expect(shouldConfirmBulkRemove([])).toBe(false);
    });
});

describe("runBulkItemActions", () => {
    it("runs actions sequentially and continues after a failure", async () => {
        const order: string[] = [];
        const firstError = await runBulkItemActions([1, 2, 3], async (item) => {
            order.push(`start-${item}`);
            await Promise.resolve();
            if (item === 2) throw new Error("boom");
            order.push(`end-${item}`);
        });

        expect(order).toEqual(["start-1", "end-1", "start-2", "start-3", "end-3"]);
        expect(firstError?.message).toBe("boom");
    });

    it("returns undefined when every action succeeds", async () => {
        expect(await runBulkItemActions([1, 2], async () => undefined)).toBeUndefined();
    });

    it("keeps the first error when later items also fail", async () => {
        const firstError = await runBulkItemActions(["a", "b"], async (item) => {
            throw item === "a" ? "first" : new Error("second");
        });
        expect(firstError?.message).toBe("first");
    });
});
