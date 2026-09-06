import type { Collection } from "@renderer/lib/types";
import {
    applyRenamesToTree,
    basename,
    displayPathToOriginal,
    hasSiblingNameConflict,
    joinPath,
    parentPath,
    rewritePathSet,
    validateNodeName,
} from "@shared/tree-rename";
import type { DirNode, ListZipEntriesResult } from "@shared/types";
import { setZipEntries } from "@shared/zip-tree";
import { create } from "zustand";

export type DownloadPreparationState =
    | { status: "idle" }
    | { status: "preparing" }
    | { status: "passwordRequired"; invalid: boolean }
    | { status: "ready"; draftId: string; collection: Collection }
    | { status: "error"; message: string };

export type NewDownloadItem = {
    key: string;
    url: string;
    password: string;
    preparation: DownloadPreparationState;
    selected: Set<string>;
    zipPasswords: Record<string, string>;
    zipLoadingPaths: Set<string>;
    /** original relative path → new basename */
    renames: Record<string, string>;
};

export type ZipEntriesApplyResult =
    | { action: "ignore" }
    | { action: "clear" }
    | { action: "passwordRequired"; invalid: boolean }
    | { action: "failed" }
    | { action: "ready"; nextTree: DirNode };

export function applyZipEntriesResult(
    requestedDraftId: string,
    current: DownloadPreparationState,
    result: ListZipEntriesResult,
    fileId: string,
): ZipEntriesApplyResult {
    if (result.status === "passwordRequired") {
        if (current.status !== "ready" || current.draftId !== requestedDraftId) {
            return { action: "ignore" };
        }
        return { action: "passwordRequired", invalid: result.invalid };
    }
    if (result.status === "failed") {
        if (
            result.code === "staleDraft" &&
            current.status === "ready" &&
            current.draftId === requestedDraftId
        ) {
            return { action: "clear" };
        }
        if (current.status === "ready" && current.draftId === requestedDraftId) {
            return { action: "failed" };
        }
        return { action: "ignore" };
    }
    if (current.status !== "ready" || current.draftId !== requestedDraftId) {
        return { action: "ignore" };
    }
    return {
        action: "ready",
        nextTree: setZipEntries(current.collection.tree, fileId, result.entries),
    };
}

export function createDownloadDraftItem(url: string): NewDownloadItem {
    return {
        key: crypto.randomUUID(),
        url,
        password: "",
        preparation: { status: "preparing" },
        selected: new Set(),
        zipPasswords: {},
        zipLoadingPaths: new Set(),
        renames: {},
    };
}

export function getStartableDraftItems(items: NewDownloadItem[]) {
    return items.filter((item) => item.preparation.status === "ready" && item.selected.size > 0);
}

export function hasPreparingDraftItems(items: NewDownloadItem[]) {
    return items.some((item) => item.preparation.status === "preparing");
}

export function canStartDownloads(items: NewDownloadItem[], savePath: string) {
    return (
        savePath.trim().length > 0 &&
        !hasPreparingDraftItems(items) &&
        getStartableDraftItems(items).length > 0
    );
}

export function shouldLoadPastedShare(items: NewDownloadItem[], url: string) {
    return items.length !== 1 || items[0].url !== url;
}

export function itemDisplayTree(item: NewDownloadItem) {
    if (item.preparation.status !== "ready") {
        return null;
    }
    return applyRenamesToTree(item.preparation.collection.tree, item.renames);
}

function updateItem(
    items: NewDownloadItem[],
    key: string,
    updater: (item: NewDownloadItem) => NewDownloadItem,
) {
    return items.map((item) => (item.key === key ? updater(item) : item));
}

type NewDownloadDraftState = {
    url: string;
    items: NewDownloadItem[];
    savePath: string;
    createCollectionSubfolder: boolean;
    asciiFilenames: boolean;
    settingsHydrated: boolean;
};

type NewDownloadDraftActions = {
    setUrl: (url: string) => void;
    setSavePath: (savePath: string) => void;
    setCreateCollectionSubfolder: (createCollectionSubfolder: boolean) => void;
    replaceItems: (urls: string[]) => void;
    setItemPassword: (key: string, password: string) => void;
    setItemPreparation: (key: string, preparation: DownloadPreparationState) => void;
    setItemSelected: (key: string, selected: Set<string>) => void;
    updateItemSelected: (key: string, updater: (selected: Set<string>) => Set<string>) => void;
    setItemZipPassword: (key: string, fileId: string, password: string) => void;
    setItemZipLoading: (key: string, path: string, loading: boolean) => void;
    renameItemNode: (
        key: string,
        displayPath: string,
        newName: string,
        displayTree: Collection["tree"],
    ) => string | null;
    removeItem: (key: string) => void;
    resetDraft: () => void;
    hydrateSettings: () => Promise<void>;
};

type NewDownloadDraftStore = NewDownloadDraftState & NewDownloadDraftActions;

const draftDefaults = {
    url: "",
    items: [],
    savePath: "",
    createCollectionSubfolder: true,
    asciiFilenames: false,
    settingsHydrated: false,
} satisfies NewDownloadDraftState;

export const useNewDownloadDraft = create<NewDownloadDraftStore>((set, get) => ({
    ...draftDefaults,

    setUrl: (url) => set({ url }),

    setSavePath: (savePath) => set({ savePath }),

    setCreateCollectionSubfolder: (createCollectionSubfolder) => set({ createCollectionSubfolder }),

    replaceItems: (urls) =>
        set({
            url: urls.length === 1 ? urls[0] : "",
            items: urls.map((itemUrl) => createDownloadDraftItem(itemUrl)),
        }),

    setItemPassword: (key, password) =>
        set({ items: updateItem(get().items, key, (item) => ({ ...item, password })) }),

    setItemPreparation: (key, preparation) =>
        set({
            items: updateItem(get().items, key, (item) => ({
                ...item,
                preparation,
                renames:
                    preparation.status !== "ready" ||
                    preparation.collection.shareId !==
                        (item.preparation.status === "ready"
                            ? item.preparation.collection.shareId
                            : undefined)
                        ? {}
                        : item.renames,
            })),
        }),

    setItemSelected: (key, selected) =>
        set({ items: updateItem(get().items, key, (item) => ({ ...item, selected })) }),

    updateItemSelected: (key, updater) =>
        set({
            items: updateItem(get().items, key, (item) => ({
                ...item,
                selected: updater(item.selected),
            })),
        }),

    setItemZipPassword: (key, fileId, password) =>
        set({
            items: updateItem(get().items, key, (item) => ({
                ...item,
                zipPasswords: { ...item.zipPasswords, [fileId]: password },
            })),
        }),

    setItemZipLoading: (key, path, loading) =>
        set({
            items: updateItem(get().items, key, (item) => {
                const zipLoadingPaths = new Set(item.zipLoadingPaths);
                if (loading) {
                    zipLoadingPaths.add(path);
                } else {
                    zipLoadingPaths.delete(path);
                }
                return { ...item, zipLoadingPaths };
            }),
        }),

    renameItemNode: (key, displayPath, newName, displayTree) => {
        const item = get().items.find((candidate) => candidate.key === key);
        const collection =
            item?.preparation.status === "ready" ? item.preparation.collection : null;
        if (!item || !collection) {
            return "컬렉션이 없습니다.";
        }
        const trimmed = newName.trim();
        const validationError = validateNodeName(trimmed);
        if (validationError) {
            return validationError;
        }
        if (basename(displayPath) === trimmed) {
            return null;
        }
        if (hasSiblingNameConflict(displayTree, parentPath(displayPath), trimmed, displayPath)) {
            return "같은 위치에 동일한 이름이 이미 있습니다.";
        }

        const originalPath =
            displayPathToOriginal(collection.tree, item.renames, displayPath) ?? displayPath;
        const nextDisplayPath = joinPath(parentPath(displayPath), trimmed);
        const renames = { ...item.renames, [originalPath]: trimmed };
        if (trimmed === basename(originalPath)) {
            delete renames[originalPath];
        }

        set({
            items: updateItem(get().items, key, (current) => ({
                ...current,
                renames,
                selected: rewritePathSet(current.selected, displayPath, nextDisplayPath),
                zipLoadingPaths: rewritePathSet(
                    current.zipLoadingPaths,
                    displayPath,
                    nextDisplayPath,
                ),
            })),
        });
        return null;
    },

    removeItem: (key) =>
        set((state) => {
            const items = state.items.filter((item) => item.key !== key);
            if (items.length === 0) {
                return { url: "", items };
            }
            return { items };
        }),

    resetDraft: () =>
        set({
            url: "",
            items: [],
        }),

    hydrateSettings: async () => {
        if (get().settingsHydrated) return;

        const values = await window.api.invoke("setting:getMany", [
            "general.lastDownloadPath",
            "general.createCollectionSubfolder",
            "general.asciiFilenames",
        ]);

        set({
            savePath: values["general.lastDownloadPath"] ?? "",
            createCollectionSubfolder: values["general.createCollectionSubfolder"] ?? true,
            asciiFilenames: values["general.asciiFilenames"] ?? false,
            settingsHydrated: true,
        });
    },
}));
