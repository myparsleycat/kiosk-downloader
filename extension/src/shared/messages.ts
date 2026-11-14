export type AppConnection =
    | { state: "connected"; port: number; version: string; protocol: number }
    | { state: "pairingRequired"; port: number; version: string; protocol: number }
    | { state: "offline" };

export type AppFailure = {
    ok: false;
    reason: "offline" | "outdated" | "pairingDenied" | "failed";
    message?: string;
};

export type SendResult = { ok: true } | AppFailure;

export type AppResult<T> = { ok: true; value: T } | AppFailure;

export type ExtensionMessage =
    | { type: "sendLinks"; urls: string[]; pageUrl: string }
    | { type: "openPopover"; url: string; pageUrl: string }
    | { type: "getConnection" }
    | { type: "pair" }
    | { type: "launchApp" };

export type ExtensionMessageResponse<T extends ExtensionMessage> = T extends { type: "sendLinks" }
    ? SendResult
    : T extends { type: "openPopover" }
      ? string
      : AppConnection;

export function sendExtensionMessage<T extends ExtensionMessage>(
    message: T,
): Promise<ExtensionMessageResponse<T>> {
    return chrome.runtime.sendMessage(message);
}
