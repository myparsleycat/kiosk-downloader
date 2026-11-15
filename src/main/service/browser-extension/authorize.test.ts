import { describe, expect, it } from "vitest";

import { authorizeExtensionRequest } from "./authorize";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const PORT = 41730;

function authorize(overrides: {
    host?: string;
    origin?: string;
    allowedIds?: string[];
    deniedIds?: string[];
}) {
    return authorizeExtensionRequest({
        host: "host" in overrides ? overrides.host : `127.0.0.1:${PORT}`,
        origin: "origin" in overrides ? overrides.origin : `chrome-extension://${EXTENSION_ID}`,
        port: PORT,
        allowedIds: overrides.allowedIds ?? [],
        deniedIds: new Set(overrides.deniedIds ?? []),
    });
}

describe("authorizeExtensionRequest", () => {
    it("rejects a rebinding host even from an approved extension", () => {
        expect(authorize({ host: `evil.example:${PORT}`, allowedIds: [EXTENSION_ID] })).toEqual({
            status: "rejected",
            reason: "host",
        });
        expect(authorize({ host: undefined, allowedIds: [EXTENSION_ID] }).status).toBe("rejected");
    });

    it("rejects web page origins and requests without an origin", () => {
        expect(authorize({ origin: "https://evil.example" })).toEqual({
            status: "rejected",
            reason: "origin",
        });
        expect(authorize({ origin: undefined })).toEqual({ status: "rejected", reason: "origin" });
        expect(authorize({ origin: "chrome-extension://not-an-id" }).status).toBe("rejected");
    });

    it("asks to pair unknown extensions and remembers denials", () => {
        expect(authorize({})).toEqual({ status: "pairingRequired", extensionId: EXTENSION_ID });
        expect(authorize({ deniedIds: [EXTENSION_ID] })).toEqual({
            status: "rejected",
            reason: "denied",
        });
    });

    it("accepts an approved extension on either loopback host name", () => {
        expect(authorize({ allowedIds: [EXTENSION_ID] })).toEqual({
            status: "ok",
            extensionId: EXTENSION_ID,
        });
        expect(authorize({ host: `localhost:${PORT}`, allowedIds: [EXTENSION_ID] }).status).toBe(
            "ok",
        );
    });
});
