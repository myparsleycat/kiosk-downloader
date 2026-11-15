import { type DirNode, type SortDir, type SortField, sortTree } from "@renderer/lib/types";
import { useFileListSettings } from "@renderer/stores/file-list-settings";
import * as React from "react";

export function useSortedTree(tree: DirNode | null | undefined, field: SortField, dir: SortDir) {
    const foldersFirst = useFileListSettings((state) => state.foldersFirst);
    return React.useMemo(
        () => (tree ? sortTree(tree, field, dir, foldersFirst) : null),
        [tree, field, dir, foldersFirst],
    );
}
