import type { DirNode } from "@shared/types";

const MAX_CACHED_TREES = 32;

/**
 * Returns the same tree object while an owner's stored JSON is unchanged, so progress publishes
 * can skip re-parsing and compare trees by reference. Callers must not mutate the returned tree.
 * Least recently used owners are evicted so idle items do not keep their trees in memory.
 */
export class ParsedTreeCache {
    private readonly entries = new Map<string, { json: string; tree: DirNode }>();

    public get(ownerId: string, json: string) {
        const cached = this.entries.get(ownerId);
        this.entries.delete(ownerId);
        const tree = cached?.json === json ? cached.tree : (JSON.parse(json) as DirNode);
        this.entries.set(ownerId, { json, tree });
        if (this.entries.size > MAX_CACHED_TREES) {
            this.entries.delete(this.entries.keys().next().value as string);
        }
        return tree;
    }

    public delete(ownerId: string) {
        this.entries.delete(ownerId);
    }
}
