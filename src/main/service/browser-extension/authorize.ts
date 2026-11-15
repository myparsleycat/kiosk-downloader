import { parseExtensionOrigin } from "@shared/browser-extension";

export type ExtensionRequestAuthorization =
    | { status: "ok"; extensionId: string }
    | { status: "pairingRequired"; extensionId: string }
    | { status: "rejected"; reason: "host" | "origin" | "denied" };

// Checking Host blocks DNS rebinding: a page on an attacker domain that resolves to 127.0.0.1
// still sends its own hostname here.
export function isLoopbackHost(host: string | undefined, port: number) {
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function authorizeExtensionRequest(input: {
    host: string | undefined;
    origin: string | undefined;
    port: number;
    allowedIds: readonly string[];
    deniedIds: ReadonlySet<string>;
}): ExtensionRequestAuthorization {
    if (!isLoopbackHost(input.host, input.port)) {
        return { status: "rejected", reason: "host" };
    }
    // Web pages cannot send a chrome-extension:// Origin, so this limits callers to extensions.
    const extensionId = parseExtensionOrigin(input.origin);
    if (!extensionId) {
        return { status: "rejected", reason: "origin" };
    }
    if (input.allowedIds.includes(extensionId)) {
        return { status: "ok", extensionId };
    }
    if (input.deniedIds.has(extensionId)) {
        return { status: "rejected", reason: "denied" };
    }
    return { status: "pairingRequired", extensionId };
}
