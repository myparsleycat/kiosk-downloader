import type { CollectionTree, DirNode } from "./types";

export function hasRedundantCollectionRootDir(tree: CollectionTree, collectionName: string) {
    if (tree.entries.length !== 1 || tree.entries[0].kind !== "dir") {
        return false;
    }

    return (tree.entries[0].node as DirNode).name.toLowerCase() === collectionName.toLowerCase();
}

export function shouldCreateCollectionSubfolder(
    tree: CollectionTree,
    collectionName: string,
    enabled: boolean,
) {
    return (
        enabled && tree.entries.length > 1 && !hasRedundantCollectionRootDir(tree, collectionName)
    );
}
