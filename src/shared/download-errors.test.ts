import { describe, expect, it } from "vitest";

import {
    COLLECTION_EXPIRES_NEVER,
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
    EXTENDED_SHARE_INVALID_PASSWORD_ERROR,
    EXTENDED_SHARE_PASSWORD_REQUIRED_ERROR,
    ZIP_INVALID_PASSWORD_ERROR,
    ZIP_PASSWORD_REQUIRED_ERROR,
    getIpcErrorCause,
    isCollectionExpiresNever,
    isCollectionInvalidPasswordError,
    isCollectionPasswordRequiredError,
    isExtendedShareInvalidPasswordError,
    isExtendedSharePasswordRequiredError,
    isZipInvalidPasswordError,
    isZipPasswordRequiredError,
} from "./download-errors";

describe("getIpcErrorCause", () => {
    it("returns the message unchanged for a plain Error", () => {
        expect(getIpcErrorCause(new Error("Invalid password."))).toBe("Invalid password.");
    });

    it("strips a leading 'Error: ' prefix", () => {
        expect(getIpcErrorCause(new Error("Error: boom"))).toBe("boom");
    });

    it("unwraps the 'Error invoking remote method' wrapper", () => {
        expect(
            getIpcErrorCause(
                new Error("Error invoking remote method 'download:probe': Invalid password."),
            ),
        ).toBe("Invalid password.");
    });

    it("unwraps a nested 'Error:' inside the remote-method wrapper", () => {
        expect(
            getIpcErrorCause(
                new Error(
                    "Error invoking remote method 'download:probe': Error: Collection is password-protected.",
                ),
            ),
        ).toBe("Collection is password-protected.");
    });

    it("handles non-Error inputs via String()", () => {
        expect(getIpcErrorCause("some string")).toBe("some string");
        expect(getIpcErrorCause(42)).toBe("42");
        expect(getIpcErrorCause(null)).toBe("null");
    });
});

describe("collection password classifiers", () => {
    it("matches the exact collection invalid-password sentinel", () => {
        expect(isCollectionInvalidPasswordError(new Error(COLLECTION_INVALID_PASSWORD_ERROR))).toBe(
            true,
        );
    });

    it("matches the legacy 'Invalid password' spelling", () => {
        expect(isCollectionInvalidPasswordError(new Error("Invalid password"))).toBe(true);
    });

    it("matches a cause that ends with the sentinel (wrapped remote errors)", () => {
        expect(isCollectionInvalidPasswordError(new Error("probe failed: Invalid password."))).toBe(
            true,
        );
    });

    it("does not match unrelated errors", () => {
        expect(isCollectionInvalidPasswordError(new Error("network timeout"))).toBe(false);
    });

    it("matches the password-required sentinel exactly and as a suffix", () => {
        expect(
            isCollectionPasswordRequiredError(new Error(COLLECTION_PASSWORD_REQUIRED_ERROR)),
        ).toBe(true);
        expect(
            isCollectionPasswordRequiredError(new Error("load: Collection is password-protected.")),
        ).toBe(true);
        expect(isCollectionPasswordRequiredError(new Error("Invalid password."))).toBe(false);
    });
});

describe("zip password classifiers", () => {
    it("matches the zip-required sentinel exactly and as a suffix", () => {
        expect(isZipPasswordRequiredError(new Error(ZIP_PASSWORD_REQUIRED_ERROR))).toBe(true);
        expect(isZipPasswordRequiredError(new Error("inflate: ZIP is password-protected."))).toBe(
            true,
        );
        expect(isZipPasswordRequiredError(new Error("Invalid ZIP password."))).toBe(false);
    });

    it("matches the zip-invalid sentinel exactly and as a suffix", () => {
        expect(isZipInvalidPasswordError(new Error(ZIP_INVALID_PASSWORD_ERROR))).toBe(true);
        expect(isZipInvalidPasswordError(new Error("inflate: Invalid ZIP password."))).toBe(true);
        expect(isZipInvalidPasswordError(new Error("ZIP is password-protected."))).toBe(false);
    });
});

describe("extended share password classifiers", () => {
    it("matches the extended-required sentinel exactly and as a suffix", () => {
        expect(
            isExtendedSharePasswordRequiredError(new Error(EXTENDED_SHARE_PASSWORD_REQUIRED_ERROR)),
        ).toBe(true);
        expect(
            isExtendedSharePasswordRequiredError(
                new Error(`wrap: ${EXTENDED_SHARE_PASSWORD_REQUIRED_ERROR}`),
            ),
        ).toBe(true);
        expect(isExtendedSharePasswordRequiredError(new Error("Incorrect password..."))).toBe(
            false,
        );
    });

    it("matches the extended-invalid sentinel exactly and as a suffix", () => {
        expect(
            isExtendedShareInvalidPasswordError(new Error(EXTENDED_SHARE_INVALID_PASSWORD_ERROR)),
        ).toBe(true);
        expect(
            isExtendedShareInvalidPasswordError(
                new Error(`wrap: ${EXTENDED_SHARE_INVALID_PASSWORD_ERROR}`),
            ),
        ).toBe(true);
        expect(isExtendedShareInvalidPasswordError(new Error("Password is required..."))).toBe(
            false,
        );
    });
});

describe("isCollectionExpiresNever", () => {
    it("returns true at and above the never-expires threshold", () => {
        expect(isCollectionExpiresNever(COLLECTION_EXPIRES_NEVER)).toBe(true);
        expect(isCollectionExpiresNever(COLLECTION_EXPIRES_NEVER + 10_000)).toBe(true);
    });

    it("returns false below the threshold", () => {
        expect(isCollectionExpiresNever(COLLECTION_EXPIRES_NEVER - 1)).toBe(false);
        expect(isCollectionExpiresNever(0)).toBe(false);
    });
});
