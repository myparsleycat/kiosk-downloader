import { cachedSpeedOrClearIfStale, SPEED_EMA_TAU_MS, updateSpeedEma } from "../transfer-speed";

const SPEED_WINDOW_MS = 2000;
const MIN_SPEED_SAMPLE_SPAN_MS = 500;
type ByteSample = { t: number; b: number };

export class DownloadTransferMetrics {
    // Progress is based on written bytes; speed is based on cumulative transferred bytes.
    private readonly writtenByChunk = new Map<string, number>();
    private readonly writtenByFile = new Map<string, number>();
    private readonly writtenByCollection = new Map<string, number>();
    private readonly transferredByChunk = new Map<string, number>();
    private readonly transferredByFile = new Map<string, number>();
    private readonly transferredByCollection = new Map<string, number>();
    private readonly collectionByFile = new Map<string, string>();
    private readonly samplesByFile = new Map<string, ByteSample[]>();
    private readonly samplesByCollection = new Map<string, ByteSample[]>();
    private readonly speedByFile = new Map<string, number>();
    private readonly speedByCollection = new Map<string, number>();
    private readonly lastEmaAtByFile = new Map<string, number>();
    private readonly lastEmaAtByCollection = new Map<string, number>();
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
        const previous = this.writtenByChunk.get(key) ?? 0;
        this.writtenByChunk.set(key, writtenBytes);
        this.setWrittenSum(fileId, (this.writtenByFile.get(fileId) ?? 0) + writtenBytes - previous);
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
    }

    public clearChunk(fileId: string, chunkIndex: number, persistedDownloaded?: number) {
        const key = this.chunkKey(fileId, chunkIndex);
        const previous = this.writtenByChunk.get(key) ?? 0;
        const previousTransferred = this.transferredByChunk.get(key) ?? 0;
        this.writtenByChunk.delete(key);
        this.transferredByChunk.delete(key);
        this.setWrittenSum(fileId, (this.writtenByFile.get(fileId) ?? 0) - previous);
        if (persistedDownloaded === undefined && previousTransferred > 0) {
            this.addTransferredBytes(fileId, -previousTransferred);
        }
        if (persistedDownloaded !== undefined) {
            this.persistedByFile.set(fileId, persistedDownloaded);
        }
    }

    public clearFile(fileId: string) {
        this.setWrittenSum(fileId, 0);
        for (const key of this.writtenByChunk.keys()) {
            if (key.startsWith(`${fileId}:`)) {
                this.writtenByChunk.delete(key);
            }
        }
        for (const key of this.transferredByChunk.keys()) {
            if (key.startsWith(`${fileId}:`)) {
                this.transferredByChunk.delete(key);
            }
        }
        this.samplesByFile.delete(fileId);
        this.speedByFile.delete(fileId);
        this.lastEmaAtByFile.delete(fileId);
        this.persistedByFile.delete(fileId);
        this.transferredByFile.delete(fileId);
        this.collectionByFile.delete(fileId);
    }

    public getFileSnapshot(fileId: string, persistedDownloaded: number) {
        this.ensurePersistedDownloaded(fileId, persistedDownloaded);
        return {
            liveDownloaded: this.getTotalBytes(fileId),
            speedBps: this.speedByFile.get(fileId) ?? 0,
        };
    }

    public sampleFile(fileId: string, persistedDownloaded: number) {
        this.ensurePersistedDownloaded(fileId, persistedDownloaded);
        const liveDownloaded = this.getTotalBytes(fileId);
        return {
            liveDownloaded,
            speedBps: this.recordSpeedSample(
                fileId,
                this.transferredByFile.get(fileId) ?? 0,
                this.samplesByFile,
                this.speedByFile,
                this.lastEmaAtByFile,
            ),
        };
    }

    public getCollectionSnapshot(collectionId: string) {
        return {
            activeTransferredBytes: this.writtenByCollection.get(collectionId) ?? 0,
            speedBps: this.speedByCollection.get(collectionId) ?? 0,
        };
    }

    public sampleCollection(collectionId: string) {
        return this.recordSpeedSample(
            collectionId,
            this.transferredByCollection.get(collectionId) ?? 0,
            this.samplesByCollection,
            this.speedByCollection,
            this.lastEmaAtByCollection,
        );
    }

    public clearCollection(collectionId: string) {
        this.samplesByCollection.delete(collectionId);
        this.speedByCollection.delete(collectionId);
        this.lastEmaAtByCollection.delete(collectionId);
        this.writtenByCollection.delete(collectionId);
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

    private setWrittenSum(fileId: string, bytes: number) {
        const previous = this.writtenByFile.get(fileId) ?? 0;
        if (bytes > 0) {
            this.writtenByFile.set(fileId, bytes);
        } else {
            this.writtenByFile.delete(fileId);
        }

        const collectionId = this.collectionByFile.get(fileId);
        if (!collectionId) {
            return;
        }
        const collectionBytes =
            (this.writtenByCollection.get(collectionId) ?? 0) + bytes - previous;
        if (collectionBytes > 0) {
            this.writtenByCollection.set(collectionId, collectionBytes);
        } else {
            this.writtenByCollection.delete(collectionId);
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
        return (this.persistedByFile.get(fileId) ?? 0) + (this.writtenByFile.get(fileId) ?? 0);
    }

    private recordSpeedSample(
        key: string,
        totalBytes: number,
        samplesByKey: Map<string, ByteSample[]>,
        speedByKey: Map<string, number>,
        lastEmaAtByKey: Map<string, number>,
    ) {
        const now = Date.now();
        const samples = samplesByKey.get(key) ?? [];
        samples.push({ t: now, b: totalBytes });
        const window = samples.filter((sample) => now - sample.t <= SPEED_WINDOW_MS);
        samplesByKey.set(key, window);

        if (window.length < 2) {
            return cachedSpeedOrClearIfStale(now, key, speedByKey, lastEmaAtByKey, SPEED_WINDOW_MS);
        }

        const first = window[0];
        const last = window[window.length - 1];
        const elapsedMs = last.t - first.t;
        if (elapsedMs < MIN_SPEED_SAMPLE_SPAN_MS) {
            return cachedSpeedOrClearIfStale(now, key, speedByKey, lastEmaAtByKey, SPEED_WINDOW_MS);
        }

        const instantBps = Math.max(0, (last.b - first.b) / (elapsedMs / 1000));
        const prevEma = speedByKey.get(key);
        const lastEmaAt = lastEmaAtByKey.get(key);
        const dtMs = lastEmaAt === undefined ? Number.POSITIVE_INFINITY : now - lastEmaAt;
        const speedBps = updateSpeedEma(prevEma, instantBps, dtMs, SPEED_EMA_TAU_MS);
        speedByKey.set(key, speedBps);
        lastEmaAtByKey.set(key, now);
        return speedBps;
    }
}
