import { performance } from "node:perf_hooks";

const SPEED_WINDOW_MS = 3000;
const MIN_SPEED_SAMPLE_SPAN_MS = 500;
type ByteSample = { t: number; b: number };

export class UploadTransferMetrics {
    private readonly activeTransferredByChunk = new Map<string, number>();
    private readonly activeTransferredByFile = new Map<string, number>();
    private readonly activeTransferredByCollection = new Map<string, number>();
    private readonly observedTransferredByFile = new Map<string, number>();
    private readonly observedTransferredByCollection = new Map<string, number>();
    private readonly collectionByFile = new Map<string, string>();
    private readonly samplesByFile = new Map<string, ByteSample[]>();
    private readonly samplesByCollection = new Map<string, ByteSample[]>();
    private readonly speedByFile = new Map<string, number>();
    private readonly speedByCollection = new Map<string, number>();

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
        this.samplesByFile.delete(fileId);
        this.speedByFile.delete(fileId);
        this.activeTransferredByFile.delete(fileId);
        this.observedTransferredByFile.delete(fileId);
        this.collectionByFile.delete(fileId);
    }

    public getFileSnapshot(fileId: string, persistedUploaded: number) {
        return {
            uploaded: persistedUploaded + (this.activeTransferredByFile.get(fileId) ?? 0),
            speedBps: this.speedByFile.get(fileId) ?? 0,
        };
    }

    public sampleFile(fileId: string, persistedUploaded: number) {
        return {
            uploaded: persistedUploaded + (this.activeTransferredByFile.get(fileId) ?? 0),
            speedBps: this.recordSpeedSample(
                fileId,
                this.observedTransferredByFile.get(fileId) ?? 0,
                this.samplesByFile,
                this.speedByFile,
            ),
        };
    }

    public getCollectionSnapshot(collectionId: string) {
        return {
            activeTransferredBytes: this.activeTransferredByCollection.get(collectionId) ?? 0,
            speedBps: this.speedByCollection.get(collectionId) ?? 0,
        };
    }

    public sampleCollection(collectionId: string) {
        return this.recordSpeedSample(
            collectionId,
            this.observedTransferredByCollection.get(collectionId) ?? 0,
            this.samplesByCollection,
            this.speedByCollection,
        );
    }

    public clearCollection(collectionId: string) {
        const fileIds = [...this.collectionByFile]
            .filter(([, fileCollectionId]) => fileCollectionId === collectionId)
            .map(([fileId]) => fileId);
        for (const fileId of fileIds) {
            this.clearFile(fileId);
        }
        this.samplesByCollection.delete(collectionId);
        this.speedByCollection.delete(collectionId);
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

    private recordSpeedSample(
        key: string,
        totalBytes: number,
        samplesByKey: Map<string, ByteSample[]>,
        speedByKey: Map<string, number>,
    ) {
        const now = performance.now();
        const samples = samplesByKey.get(key) ?? [];
        samples.push({ t: now, b: totalBytes });
        const window = samples.filter((sample) => now - sample.t <= SPEED_WINDOW_MS);
        samplesByKey.set(key, window);

        if (window.length < 2) {
            speedByKey.set(key, 0);
            return 0;
        }

        const first = window[0];
        const last = window[window.length - 1];
        const elapsedMs = last.t - first.t;
        if (elapsedMs < MIN_SPEED_SAMPLE_SPAN_MS) {
            speedByKey.set(key, 0);
            return 0;
        }

        const speedBps = Math.max(0, (last.b - first.b) / (elapsedMs / 1000));
        speedByKey.set(key, speedBps);
        return speedBps;
    }
}
