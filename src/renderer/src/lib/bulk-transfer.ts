import type { DownloadStatus, UploadStatus } from "@shared/types";

export type BulkTransferStatus = DownloadStatus | UploadStatus;

export function isBulkStartable(status: BulkTransferStatus): boolean {
    return status === "paused" || status === "queued" || status === "error";
}

export function isBulkPausable(kind: "download" | "upload", status: BulkTransferStatus): boolean {
    if (kind === "download") {
        return status === "downloading" || status === "inflating" || status === "queued";
    }
    return status === "uploading" || status === "queued";
}

export function shouldConfirmBulkRemove(items: { status: string }[]): boolean {
    return items.some((item) => item.status !== "completed");
}

export async function runBulkItemActions<T>(
    items: T[],
    action: (item: T) => Promise<unknown>,
): Promise<Error | undefined> {
    let firstError: Error | undefined;
    for (const item of items) {
        try {
            await action(item);
        } catch (error) {
            firstError ??= error instanceof Error ? error : new Error(String(error));
        }
    }
    return firstError;
}
