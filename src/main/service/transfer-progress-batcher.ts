const PROGRESS_EMIT_INTERVAL_MS = 500;

export class TransferProgressBatcher {
    private readonly dirtyFileIdsByCollection = new Map<string, Set<string>>();
    private readonly dirtyCollections = new Set<string>();
    private readonly updatesInFlight = new Set<string>();
    private timer: ReturnType<typeof setInterval> | null = null;

    public constructor(
        private readonly flush: (
            collectionId: string,
            fileIds: Set<string>,
            usageDirty: boolean,
        ) => Promise<void>,
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

    public markCollection(collectionId: string) {
        this.activate(collectionId);
        this.dirtyCollections.add(collectionId);
    }

    public deactivate(collectionId: string) {
        this.dirtyFileIdsByCollection.delete(collectionId);
        this.dirtyCollections.delete(collectionId);
        if (this.dirtyFileIdsByCollection.size === 0) {
            this.stopTimer();
        }
    }

    public destroy() {
        this.dirtyFileIdsByCollection.clear();
        this.dirtyCollections.clear();
        this.stopTimer();
    }

    private poll() {
        const collectionIds = new Set([
            ...this.dirtyFileIdsByCollection.keys(),
            ...this.dirtyCollections,
        ]);
        for (const collectionId of collectionIds) {
            void this.flushOnce(collectionId);
        }
    }

    private async flushOnce(collectionId: string) {
        if (this.updatesInFlight.has(collectionId)) {
            return;
        }
        const pending = this.dirtyFileIdsByCollection.get(collectionId);
        const usageDirty = this.dirtyCollections.delete(collectionId);
        if ((!pending || pending.size === 0) && !usageDirty) {
            return;
        }

        const fileIds = new Set(pending);
        pending?.clear();
        this.updatesInFlight.add(collectionId);
        let failed = false;
        try {
            await this.flush(collectionId, fileIds, usageDirty);
        } catch (error) {
            failed = true;
            const current = this.dirtyFileIdsByCollection.get(collectionId);
            if (current) {
                for (const fileId of fileIds) {
                    current.add(fileId);
                }
            }
            if (usageDirty) {
                this.dirtyCollections.add(collectionId);
            }
            this.onError(error, collectionId);
        } finally {
            this.updatesInFlight.delete(collectionId);
            // Flush again immediately when progress arrived during the in-flight emit.
            // Skip on failure so retries wait for the next poll interval instead of looping.
            if (
                !failed &&
                ((this.dirtyFileIdsByCollection.get(collectionId)?.size ?? 0) > 0 ||
                    this.dirtyCollections.has(collectionId))
            ) {
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
