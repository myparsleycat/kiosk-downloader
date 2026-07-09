const SPEED_WINDOW_MS = 2000;
const MIN_SPEED_SAMPLE_SPAN_MS = 500;
type ByteSample = { t: number; b: number };

export class UploadTransferMetrics {
    private readonly transferredByChunk = new Map<string, number>();
    private readonly transferredByFile = new Map<string, number>();
    private readonly transferredByCollection = new Map<string, number>();
    private readonly collectionByFile = new Map<string, string>();
    private readonly samplesByFile = new Map<string, ByteSample[]>();
    private readonly samplesByCollection = new Map<string, ByteSample[]>();
    private readonly speedByFile = new Map<string, number>();
    private readonly speedByCollection = new Map<string, number>();

    public registerFile(collectionId: string, fileId: string) {
        this.collectionByFile.set(fileId, collectionId);
        if (!this.transferredByFile.has(fileId)) {
            this.transferredByFile.set(fileId, 0);
        }
        if (!this.transferredByCollection.has(collectionId)) {
            this.transferredByCollection.set(collectionId, 0);
        }
    }

    public addChunkBytes(fileId: string, chunkIndex: number, bytes: number) {
        const key = this.chunkKey(fileId, chunkIndex);
        const previous = this.transferredByChunk.get(key) ?? 0;
        const normalized = Math.max(0, bytes);
        const delta = normalized - previous;
        if (delta === 0) {
            return;
        }

        this.transferredByChunk.set(key, normalized);
        this.addTransferredBytes(fileId, delta);
    }

    public clearChunk(fileId: string, chunkIndex: number) {
        const key = this.chunkKey(fileId, chunkIndex);
        const previous = this.transferredByChunk.get(key) ?? 0;
        if (previous > 0) {
            this.transferredByChunk.delete(key);
            this.addTransferredBytes(fileId, -previous);
        }
    }

    public clearFile(fileId: string) {
        for (const key of this.transferredByChunk.keys()) {
            if (key.startsWith(`${fileId}:`)) {
                this.transferredByChunk.delete(key);
            }
        }
        this.samplesByFile.delete(fileId);
        this.speedByFile.delete(fileId);
        this.transferredByFile.delete(fileId);
        this.collectionByFile.delete(fileId);
    }

    public getFileSnapshot(fileId: string) {
        return {
            uploaded: this.transferredByFile.get(fileId) ?? 0,
            speedBps: this.speedByFile.get(fileId) ?? 0,
        };
    }

    public sampleFile(fileId: string) {
        return {
            uploaded: this.transferredByFile.get(fileId) ?? 0,
            speedBps: this.recordSpeedSample(
                fileId,
                this.transferredByFile.get(fileId) ?? 0,
                this.samplesByFile,
                this.speedByFile,
            ),
        };
    }

    public getCollectionSnapshot(collectionId: string) {
        return {
            speedBps: this.speedByCollection.get(collectionId) ?? 0,
        };
    }

    public sampleCollection(collectionId: string) {
        return this.recordSpeedSample(
            collectionId,
            this.transferredByCollection.get(collectionId) ?? 0,
            this.samplesByCollection,
            this.speedByCollection,
        );
    }

    public clearCollection(collectionId: string) {
        this.samplesByCollection.delete(collectionId);
        this.speedByCollection.delete(collectionId);
        this.transferredByCollection.delete(collectionId);
    }

    private chunkKey(fileId: string, chunkIndex: number) {
        return `${fileId}:${chunkIndex}`;
    }

    private addTransferredBytes(fileId: string, bytes: number) {
        const fileBytes = (this.transferredByFile.get(fileId) ?? 0) + bytes;
        if (fileBytes > 0) {
            this.transferredByFile.set(fileId, fileBytes);
        } else {
            this.transferredByFile.set(fileId, 0);
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

        this.transferredByCollection.set(collectionId, 0);
    }

    private recordSpeedSample(
        key: string,
        totalBytes: number,
        samplesByKey: Map<string, ByteSample[]>,
        speedByKey: Map<string, number>,
    ) {
        const now = Date.now();
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
