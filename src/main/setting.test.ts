import { describe, expect, it, vi } from "vitest";

import type { KioskDownloader } from ".";

import Setting, { normalizeCollectionPasswordList } from "./setting";

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

describe("request pool settings", () => {
    it("migrates the first legacy value and clamps it to the new range", async () => {
        const { setting, stored } = createSetting({
            "transfer.segmentPoolSize": "2",
            "transfer.maxConcurrentSegments": "24",
            "transfer.maxSegmentsPerFile": "12",
        });

        await expect(setting.get("transfer.requestPoolSize")).resolves.toBe(2);
        expect(stored.get("transfer.requestPoolSize")).toBe("2");
    });

    it("uses the new default when no current or legacy value exists", async () => {
        const { setting, stored } = createSetting({});

        await expect(setting.get("transfer.requestPoolSize")).resolves.toBe(8);
        expect(stored.get("transfer.requestPoolSize")).toBe("8");
    });
});

function createSetting(initial: Record<string, string>) {
    const stored = new Map(Object.entries(initial));
    const kd = {
        lib: {
            db: {
                settings: {
                    get: vi.fn(async (key: string) =>
                        stored.has(key) ? { key, value: stored.get(key) } : null,
                    ),
                    upsert: vi.fn(async (key: string, value: string | null) => {
                        if (value === null) {
                            stored.delete(key);
                            return;
                        }
                        stored.set(key, value);
                    }),
                },
            },
        },
        service: {
            transfer: { setRequestPoolSize: vi.fn() },
        },
        ipc: { sendToMainWindow: vi.fn() },
    } as unknown as KioskDownloader;

    return { setting: new Setting(kd), stored };
}
