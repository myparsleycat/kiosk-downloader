import { performance } from "node:perf_hooks";

import { TransferSpeedSampler } from "../transfer-speed";

const SPEED_WINDOW_MS = 3000;

export class UploadTransferMetrics {
    private readonly activeTransferredByChunk = new Map<string, number>();
    private readonly activeTransferredByFile = new Map<string, number>();
    private readonly activeTransferredByCollection = new Map<string, number>();
    private readonly observedTransferredByFile = new Map<string, number>();
    private readonly observedTransferredByCollection = new Map<string, number>();
    private readonly collectionByFile = new Map<string, string>();
    private readonly fileSpeed = new TransferSpeedSampler(() => performance.now(), SPEED_WINDOW_MS);
    private readonly collectionSpeed = new TransferSpeedSampler(
        () => performance.now(),
        SPEED_WINDOW_MS,
    );

    public registerFile(collectionId: string, fileId: string) {
        this.collectionByFile.set(fileId, collectionId);
        if (!this.activeTransferredByFile.has(fileId)) {
            this.activeTransferredByFile.set(fileId, 0);
        }
        if (!this.activeTransferredByCollection.has(collectionId)) {
            this.activeTransferredByCollection.set(collectionId, 0);
        }
    }

    public setChunkTransferProgress(fileId: string, chunkIndex: number, bytes: number) {
        const key = this.chunkKey(fileId, chunkIndex);
        const previous = this.activeTransferredByChunk.get(key) ?? 0;
        const normalized = Math.max(0, bytes);
        const delta = normalized - previous;
        if (delta === 0) {
            return;
        }

        if (normalized > 0) {
            this.activeTransferredByChunk.set(key, normalized);
        } else {
            this.activeTransferredByChunk.delete(key);
        }
        this.addActiveTransferredBytes(fileId, delta);
        if (delta > 0) {
            this.addObservedTransferredBytes(fileId, delta);
        }
    }

    public completeChunk(fileId: string, chunkIndex: number) {
        this.clearChunk(fileId, chunkIndex);
    }

    public clearChunk(fileId: string, chunkIndex: number) {
        const key = this.chunkKey(fileId, chunkIndex);
        const previous = this.activeTransferredByChunk.get(key) ?? 0;
        if (previous > 0) {
            this.activeTransferredByChunk.delete(key);
            this.addActiveTransferredBytes(fileId, -previous);
        }
    }

    public clearFile(fileId: string) {
        for (const key of this.activeTransferredByChunk.keys()) {
            if (key.startsWith(`${fileId}:`)) {
                this.activeTransferredByChunk.delete(key);
            }
        }
        this.fileSpeed.clear(fileId);
        this.activeTransferredByFile.delete(fileId);
        this.observedTransferredByFile.delete(fileId);
        this.collectionByFile.delete(fileId);
    }

    public getFileSnapshot(fileId: string, persistedUploaded: number) {
        return {
            uploaded: persistedUploaded + (this.activeTransferredByFile.get(fileId) ?? 0),
            speedBps: this.fileSpeed.get(fileId),
        };
    }

    public sampleFile(fileId: string, persistedUploaded: number) {
        return {
            uploaded: persistedUploaded + (this.activeTransferredByFile.get(fileId) ?? 0),
            speedBps: this.fileSpeed.sample(
                fileId,
                this.observedTransferredByFile.get(fileId) ?? 0,
            ),
        };
    }

    public getCollectionSnapshot(collectionId: string) {
        return {
            activeTransferredBytes: this.activeTransferredByCollection.get(collectionId) ?? 0,
            speedBps: this.collectionSpeed.get(collectionId),
        };
    }

    public sampleCollection(collectionId: string) {
        return this.collectionSpeed.sample(
            collectionId,
            this.observedTransferredByCollection.get(collectionId) ?? 0,
        );
    }

    public sampleBundle(bundleId: string, subCollectionIds: string[]) {
        const total = subCollectionIds.reduce(
            (sum, id) => sum + (this.observedTransferredByCollection.get(id) ?? 0),
            0,
        );
        return this.collectionSpeed.sample(bundleId, total);
    }

    public getBundleSnapshot(bundleId: string, subCollectionIds: string[]) {
        return {
            activeTransferredBytes: subCollectionIds.reduce(
                (sum, id) => sum + (this.activeTransferredByCollection.get(id) ?? 0),
                0,
            ),
            speedBps: this.collectionSpeed.get(bundleId),
        };
    }

    public clearBundle(bundleId: string) {
        this.collectionSpeed.clear(bundleId);
    }

    public clearCollection(collectionId: string) {
        const fileIds = [...this.collectionByFile]
            .filter(([, fileCollectionId]) => fileCollectionId === collectionId)
            .map(([fileId]) => fileId);
        for (const fileId of fileIds) {
            this.clearFile(fileId);
        }
        this.collectionSpeed.clear(collectionId);
        this.activeTransferredByCollection.delete(collectionId);
        this.observedTransferredByCollection.delete(collectionId);
    }

    private chunkKey(fileId: string, chunkIndex: number) {
        return `${fileId}:${chunkIndex}`;
    }

    private addActiveTransferredBytes(fileId: string, bytes: number) {
        const fileBytes = (this.activeTransferredByFile.get(fileId) ?? 0) + bytes;
        if (fileBytes > 0) {
            this.activeTransferredByFile.set(fileId, fileBytes);
        } else {
            this.activeTransferredByFile.delete(fileId);
        }

        const collectionId = this.collectionByFile.get(fileId);
        if (!collectionId) {
            return;
        }

        const collectionBytes = (this.activeTransferredByCollection.get(collectionId) ?? 0) + bytes;
        if (collectionBytes > 0) {
            this.activeTransferredByCollection.set(collectionId, collectionBytes);
            return;
        }

        this.activeTransferredByCollection.delete(collectionId);
    }

    private addObservedTransferredBytes(fileId: string, bytes: number) {
        this.observedTransferredByFile.set(
            fileId,
            (this.observedTransferredByFile.get(fileId) ?? 0) + bytes,
        );

        const collectionId = this.collectionByFile.get(fileId);
        if (!collectionId) {
            return;
        }

        this.observedTransferredByCollection.set(
            collectionId,
            (this.observedTransferredByCollection.get(collectionId) ?? 0) + bytes,
        );
    }
}
