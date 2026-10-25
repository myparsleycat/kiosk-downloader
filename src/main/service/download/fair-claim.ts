import { minBy } from "es-toolkit";

type ClaimableSession = {
    collectionId: string;
    inFlightChunks: number;
    failed: boolean;
    aborted: boolean;
};

/**
 * Returns the queue index of the next chunk to claim. Workers hold a chunk until it finishes and
 * are never preempted, so the collection with the fewest in-flight chunks takes every freed worker
 * until it catches up; plain rotation would hand it only every other one. Ties rotate after the
 * last claimed collection.
 */
export function findFairWorkItemIndex(
    queue: readonly { sessionId: string }[],
    sessions: ReadonlyMap<string, ClaimableSession>,
    lastClaimedCollectionId: string | null,
) {
    const inFlightByCollection = new Map<string, number>();
    for (const session of sessions.values()) {
        inFlightByCollection.set(
            session.collectionId,
            (inFlightByCollection.get(session.collectionId) ?? 0) + session.inFlightChunks,
        );
    }

    const firstIndexByCollection = new Map<string, number>();
    queue.forEach((item, index) => {
        const session = sessions.get(item.sessionId);
        if (
            session &&
            !session.failed &&
            !session.aborted &&
            !firstIndexByCollection.has(session.collectionId)
        ) {
            firstIndexByCollection.set(session.collectionId, index);
        }
    });

    const collectionIds = [...firstIndexByCollection.keys()];
    const previousIndex = lastClaimedCollectionId
        ? collectionIds.indexOf(lastClaimedCollectionId)
        : -1;
    const nextCollectionId = minBy(
        [...collectionIds.slice(previousIndex + 1), ...collectionIds.slice(0, previousIndex + 1)],
        (collectionId) => inFlightByCollection.get(collectionId) ?? 0,
    );
    return nextCollectionId === undefined ? 0 : firstIndexByCollection.get(nextCollectionId)!;
}
