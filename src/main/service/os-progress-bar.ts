import type { BrowserWindow } from "electron";

export type OsProgressTransferStatus =
    | "pending"
    | "preparing"
    | "progress"
    | "completed"
    | "paused"
    | "canceled"
    | "error";

export type OsProgressTransfer = {
    status: OsProgressTransferStatus;
    totalSize: number;
    transferedSize: number;
    progress: number;
};

export type OsProgressBarMode = "normal" | "indeterminate" | "error" | "paused";

export function getAggregateProgress(transfers: OsProgressTransfer[]): number | null {
    const remaining = transfers.filter(
        (transfer) => transfer.status !== "completed" && transfer.status !== "canceled",
    );
    if (remaining.length === 0) {
        return null;
    }

    const withSizes = remaining.map((transfer) => {
        const totalSize = Math.max(0, transfer.totalSize);
        const transferedSize =
            totalSize > 0
                ? Math.min(totalSize, Math.max(0, transfer.transferedSize))
                : Math.max(0, transfer.transferedSize);
        return {
            totalSize,
            transferedSize,
            progress: clampPercent(transfer.progress),
        };
    });

    const totalSize = withSizes.reduce((sum, transfer) => sum + transfer.totalSize, 0);
    if (totalSize > 0) {
        const transferedSize = withSizes.reduce(
            (sum, transfer) => sum + transfer.transferedSize,
            0,
        );
        return clampPercent((transferedSize / totalSize) * 100);
    }

    const progressSum = withSizes.reduce((sum, transfer) => sum + transfer.progress, 0);
    if (withSizes.length === 0) {
        return null;
    }
    return clampPercent(progressSum / withSizes.length);
}

export function resolveOsProgressBarMode(
    transfers: OsProgressTransfer[],
): OsProgressBarMode | null {
    const remaining = transfers.filter(
        (transfer) => transfer.status !== "completed" && transfer.status !== "canceled",
    );
    if (remaining.length === 0) {
        return null;
    }

    if (remaining.some((transfer) => transfer.status === "progress")) {
        return "normal";
    }
    if (
        remaining.some(
            (transfer) => transfer.status === "preparing" || transfer.status === "pending",
        )
    ) {
        return "indeterminate";
    }
    if (remaining.some((transfer) => transfer.status === "paused")) {
        return "paused";
    }
    if (remaining.some((transfer) => transfer.status === "error")) {
        return "error";
    }
    return "normal";
}

export function syncMainWindowProgressBar(
    mainWindow: BrowserWindow | null,
    transfers: OsProgressTransfer[],
) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    const mode = resolveOsProgressBarMode(transfers);
    if (mode === null) {
        mainWindow.setProgressBar(-1);
        return;
    }

    const aggregate = getAggregateProgress(transfers);
    if (aggregate === null) {
        mainWindow.setProgressBar(-1);
        return;
    }

    mainWindow.setProgressBar(aggregate / 100, { mode });
}

export function toOsProgressTransfer(input: {
    status: string;
    transferredBytes: number;
    totalBytes: number;
}): OsProgressTransfer {
    const totalSize = Math.max(0, input.totalBytes);
    const transferedSize =
        totalSize > 0
            ? Math.min(totalSize, Math.max(0, input.transferredBytes))
            : Math.max(0, input.transferredBytes);
    const progress = totalSize > 0 ? clampPercent((transferedSize / totalSize) * 100) : 0;

    return {
        status: mapTransferStatus(input.status),
        totalSize,
        transferedSize,
        progress,
    };
}

function mapTransferStatus(status: string): OsProgressTransferStatus {
    switch (status) {
        case "queued":
            return "pending";
        case "downloading":
        case "uploading":
            return "progress";
        case "paused":
            return "paused";
        case "error":
            return "error";
        case "completed":
            return "completed";
        case "expired":
            return "canceled";
        default:
            return "pending";
    }
}

function clampPercent(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(100, Math.max(0, value));
}
