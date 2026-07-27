export const COLLECTION_INVALID_PASSWORD_ERROR = "Invalid password.";
export const COLLECTION_PASSWORD_REQUIRED_ERROR = "Collection is password-protected.";
export const ZIP_PASSWORD_REQUIRED_ERROR = "ZIP is password-protected.";
export const ZIP_INVALID_PASSWORD_ERROR = "Invalid ZIP password.";
export const EXTENDED_SHARE_PASSWORD_REQUIRED_ERROR =
    "Password is required for this extended share information.";
export const EXTENDED_SHARE_INVALID_PASSWORD_ERROR =
    "Incorrect password or corrupted extended share information.";

/** Unix seconds far enough that transfer.it collections are never treated as expired. */
export const COLLECTION_EXPIRES_NEVER = 4_102_444_800; // 2100-01-01 UTC

export function isCollectionExpiresNever(expires: number) {
    return expires >= COLLECTION_EXPIRES_NEVER;
}

export function getIpcErrorCause(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const remoteMatch = message.match(/^Error invoking remote method '[^']+': (?:Error: )?(.+)$/);
    if (remoteMatch?.[1]) {
        return remoteMatch[1];
    }

    return message.replace(/^Error: /, "");
}

export function isCollectionInvalidPasswordError(error: unknown) {
    const cause = getIpcErrorCause(error);
    return (
        cause === COLLECTION_INVALID_PASSWORD_ERROR ||
        cause === "Invalid password" ||
        cause.endsWith("Invalid password.")
    );
}

export function isCollectionPasswordRequiredError(error: unknown) {
    const cause = getIpcErrorCause(error);
    return (
        cause === COLLECTION_PASSWORD_REQUIRED_ERROR ||
        cause.endsWith("Collection is password-protected.")
    );
}

export function isZipPasswordRequiredError(error: unknown) {
    const cause = getIpcErrorCause(error);
    return cause === ZIP_PASSWORD_REQUIRED_ERROR || cause.endsWith("ZIP is password-protected.");
}

export function isZipInvalidPasswordError(error: unknown) {
    const cause = getIpcErrorCause(error);
    return cause === ZIP_INVALID_PASSWORD_ERROR || cause.endsWith("Invalid ZIP password.");
}

export function isExtendedSharePasswordRequiredError(error: unknown) {
    const cause = getIpcErrorCause(error);
    return (
        cause === EXTENDED_SHARE_PASSWORD_REQUIRED_ERROR ||
        cause.endsWith(EXTENDED_SHARE_PASSWORD_REQUIRED_ERROR)
    );
}

export function isExtendedShareInvalidPasswordError(error: unknown) {
    const cause = getIpcErrorCause(error);
    return (
        cause === EXTENDED_SHARE_INVALID_PASSWORD_ERROR ||
        cause.endsWith(EXTENDED_SHARE_INVALID_PASSWORD_ERROR)
    );
}
