import { performance } from "node:perf_hooks";

import { TransferSpeedSampler } from "../transfer-speed";

const SPEED_WINDOW_MS = 2000;

export class DownloadTransferMetrics {
    // Live progress uses max(written, transferred) per in-flight chunk so the UI
    // advances on network receive, not only after disk write batches.
    // Speed still samples cumulative transferred bytes.
    private readonly writtenByChunk = new Map<string, number>();
    private readonly transferredByChunk = new Map<string, number>();
    private readonly liveByChunk = new Map<string, number>();
    private readonly liveByFile = new Map<string, number>();
    private readonly liveByCollection = new Map<string, number>();
    private readonly transferredByFile = new Map<string, number>();
    private readonly transferredByCollection = new Map<string, number>();
    private readonly collectionByFile = new Map<string, string>();
    private readonly fileSpeed = new TransferSpeedSampler(() => performance.now(), SPEED_WINDOW_MS);
    private readonly collectionSpeed = new TransferSpeedSampler(
        () => performance.now(),
        SPEED_WINDOW_MS,
    );
    private readonly persistedByFile = new Map<string, number>();

    public registerFile(collectionId: string, fileId: string, bytes: number) {
        this.collectionByFile.set(fileId, collectionId);
        if (!this.transferredByFile.has(fileId)) {
            this.transferredByFile.set(fileId, 0);
        }
        if (!this.transferredByCollection.has(collectionId)) {
            this.transferredByCollection.set(collectionId, 0);
        }
        this.persistedByFile.set(fileId, bytes);
    }

    public setChunkWriteProgress(fileId: string, chunkIndex: number, writtenBytes: number) {
        const key = this.chunkKey(fileId, chunkIndex);
        this.writtenByChunk.set(key, writtenBytes);
        this.syncChunkLive(fileId, key);
    }

    public setChunkTransferProgress(fileId: string, chunkIndex: number, transferredBytes: number) {
        if (!Number.isFinite(transferredBytes)) {
            return;
        }

        const key = this.chunkKey(fileId, chunkIndex);
        const previous = this.transferredByChunk.get(key) ?? 0;
        const normalized = Math.max(0, transferredBytes);
        const delta = normalized - previous;
        if (delta === 0) {
            return;
        }

        this.transferredByChunk.set(key, normalized);
        this.addTransferredBytes(fileId, delta);
        this.syncChunkLive(fileId, key);
    }

    public clearChunk(fileId: string, chunkIndex: number, persistedDownloaded?: number) {
        const key = this.chunkKey(fileId, chunkIndex);
        const previousTransferred = this.transferredByChunk.get(key) ?? 0;
        this.writtenByChunk.delete(key);
        this.transferredByChunk.delete(key);
        this.setLiveSum(fileId, key, 0);
        if (persistedDownloaded === undefined && previousTransferred > 0) {
            this.addTransferredBytes(fileId, -previousTransferred);
        }
        if (persistedDownloaded !== undefined) {
            this.persistedByFile.set(fileId, persistedDownloaded);
        }
    }

    public clearFile(fileId: string) {
        for (const key of [...this.liveByChunk.keys()]) {
            if (key.startsWith(`${fileId}:`)) {
                this.setLiveSum(fileId, key, 0);
                this.writtenByChunk.delete(key);
                this.transferredByChunk.delete(key);
            }
        }
        this.fileSpeed.clear(fileId);
        this.persistedByFile.delete(fileId);
        this.transferredByFile.delete(fileId);
        this.collectionByFile.delete(fileId);
    }

    public getFileSnapshot(fileId: string, persistedDownloaded: number) {
        this.ensurePersistedDownloaded(fileId, persistedDownloaded);
        return {
            liveDownloaded: this.getTotalBytes(fileId),
            speedBps: this.fileSpeed.get(fileId),
        };
    }

    public sampleFile(fileId: string, persistedDownloaded: number) {
        this.ensurePersistedDownloaded(fileId, persistedDownloaded);
        const liveDownloaded = this.getTotalBytes(fileId);
        return {
            liveDownloaded,
            speedBps: this.fileSpeed.sample(fileId, this.transferredByFile.get(fileId) ?? 0),
        };
    }

    public getCollectionSnapshot(collectionId: string) {
        return {
            activeTransferredBytes: this.liveByCollection.get(collectionId) ?? 0,
            speedBps: this.collectionSpeed.get(collectionId),
        };
    }

    public sampleCollection(collectionId: string) {
        return this.collectionSpeed.sample(
            collectionId,
            this.transferredByCollection.get(collectionId) ?? 0,
        );
    }

    public sampleBundle(bundleId: string, subCollectionIds: string[]) {
        const total = subCollectionIds.reduce(
            (sum, id) => sum + (this.transferredByCollection.get(id) ?? 0),
            0,
        );
        return this.collectionSpeed.sample(bundleId, total);
    }

    public getBundleSnapshot(bundleId: string, subCollectionIds: string[]) {
        return {
            activeTransferredBytes: subCollectionIds.reduce(
                (sum, id) => sum + (this.liveByCollection.get(id) ?? 0),
                0,
            ),
            speedBps: this.collectionSpeed.get(bundleId),
        };
    }

    public clearBundle(bundleId: string) {
        this.collectionSpeed.clear(bundleId);
    }

    public clearCollection(collectionId: string) {
        this.collectionSpeed.clear(collectionId);
        this.liveByCollection.delete(collectionId);
        this.transferredByCollection.delete(collectionId);
    }

    private chunkKey(fileId: string, chunkIndex: number) {
        return `${fileId}:${chunkIndex}`;
    }

    private ensurePersistedDownloaded(fileId: string, bytes: number) {
        if (!this.persistedByFile.has(fileId)) {
            this.persistedByFile.set(fileId, bytes);
        }
    }

    private syncChunkLive(fileId: string, key: string) {
        this.setLiveSum(
            fileId,
            key,
            Math.max(this.writtenByChunk.get(key) ?? 0, this.transferredByChunk.get(key) ?? 0),
        );
    }

    private setLiveSum(fileId: string, key: string, bytes: number) {
        const previous = this.liveByChunk.get(key) ?? 0;
        if (bytes > 0) {
            this.liveByChunk.set(key, bytes);
        } else {
            this.liveByChunk.delete(key);
        }

        const fileBytes = (this.liveByFile.get(fileId) ?? 0) + bytes - previous;
        if (fileBytes > 0) {
            this.liveByFile.set(fileId, fileBytes);
        } else {
            this.liveByFile.delete(fileId);
        }

        const collectionId = this.collectionByFile.get(fileId);
        if (!collectionId) {
            return;
        }
        const collectionBytes = (this.liveByCollection.get(collectionId) ?? 0) + bytes - previous;
        if (collectionBytes > 0) {
            this.liveByCollection.set(collectionId, collectionBytes);
        } else {
            this.liveByCollection.delete(collectionId);
        }
    }

    private addTransferredBytes(fileId: string, bytes: number) {
        const fileBytes = (this.transferredByFile.get(fileId) ?? 0) + bytes;
        if (fileBytes > 0) {
            this.transferredByFile.set(fileId, fileBytes);
        } else {
            this.transferredByFile.delete(fileId);
        }

        const collectionId = this.collectionByFile.get(fileId);
        if (!collectionId) {
            return;
        }

        const collectionBytes = (this.transferredByCollection.get(collectionId) ?? 0) + bytes;
        if (collectionBytes > 0) {
            this.transferredByCollection.set(collectionId, collectionBytes);
            return;
        }

        this.transferredByCollection.delete(collectionId);
    }

    private getTotalBytes(fileId: string) {
        return (this.persistedByFile.get(fileId) ?? 0) + (this.liveByFile.get(fileId) ?? 0);
    }
}
