import { describe, expect, it } from "vitest";

import { MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES, decodeDownloadTransfer } from "./transfer-format";

describe("download transfer format", () => {
    it("rejects compressed input larger than the configured limit", () => {
        expect(() =>
            decodeDownloadTransfer(Buffer.alloc(MAX_DOWNLOAD_TRANSFER_COMPRESSED_BYTES + 1)),
        ).toThrow("Transfer file is too large.");
    });
});
