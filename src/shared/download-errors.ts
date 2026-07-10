export const COLLECTION_INVALID_PASSWORD_ERROR = "Invalid password.";
export const COLLECTION_PASSWORD_REQUIRED_ERROR = "Collection is password-protected.";
export const ZIP_PASSWORD_REQUIRED_ERROR = "ZIP is password-protected.";
export const ZIP_INVALID_PASSWORD_ERROR = "Invalid ZIP password.";

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
