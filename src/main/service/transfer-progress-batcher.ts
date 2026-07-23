const PROGRESS_EMIT_INTERVAL_MS = 500;

export class TransferProgressBatcher {
    private readonly dirtyFileIdsByCollection = new Map<string, Set<string>>();
    private readonly updatesInFlight = new Set<string>();
    private timer: ReturnType<typeof setInterval> | null = null;

    public constructor(
        private readonly flush: (collectionId: string, fileIds: Set<string>) => Promise<void>,
        private readonly onError: (error: unknown, collectionId: string) => void,
    ) {}

    public activate(collectionId: string) {
        if (!this.dirtyFileIdsByCollection.has(collectionId)) {
            this.dirtyFileIdsByCollection.set(collectionId, new Set());
        }
        if (this.timer) {
            return;
        }
        this.timer = setInterval(() => this.poll(), PROGRESS_EMIT_INTERVAL_MS);
        this.timer.unref?.();
    }

    public mark(collectionId: string, fileId: string) {
        this.activate(collectionId);
        this.dirtyFileIdsByCollection.get(collectionId)?.add(fileId);
    }

    public deactivate(collectionId: string) {
        this.dirtyFileIdsByCollection.delete(collectionId);
        if (this.dirtyFileIdsByCollection.size === 0) {
            this.stopTimer();
        }
    }

    public destroy() {
        this.dirtyFileIdsByCollection.clear();
        this.stopTimer();
    }

    private poll() {
        for (const collectionId of this.dirtyFileIdsByCollection.keys()) {
            void this.flushOnce(collectionId);
        }
    }

    private async flushOnce(collectionId: string) {
        if (this.updatesInFlight.has(collectionId)) {
            return;
        }
        const pending = this.dirtyFileIdsByCollection.get(collectionId);
        if (!pending || pending.size === 0) {
            return;
        }

        const fileIds = new Set(pending);
        pending.clear();
        this.updatesInFlight.add(collectionId);
        try {
            await this.flush(collectionId, fileIds);
        } catch (error) {
            const current = this.dirtyFileIdsByCollection.get(collectionId);
            if (current) {
                for (const fileId of fileIds) {
                    current.add(fileId);
                }
            }
            this.onError(error, collectionId);
        } finally {
            this.updatesInFlight.delete(collectionId);
            // Flush again immediately when progress arrived during the in-flight emit.
            if ((this.dirtyFileIdsByCollection.get(collectionId)?.size ?? 0) > 0) {
                void this.flushOnce(collectionId);
            }
        }
    }

    private stopTimer() {
        if (!this.timer) {
            return;
        }
        clearInterval(this.timer);
        this.timer = null;
    }
}
