import type { Collection } from "@renderer/lib/types";
import {
    basename,
    displayPathToOriginal,
    hasSiblingNameConflict,
    joinPath,
    parentPath,
    rewritePathSet,
    validateNodeName,
} from "@shared/tree-rename";
import { create } from "zustand";

type NewDownloadDraftState = {
    url: string;
    password: string;
    savePath: string;
    createCollectionSubfolder: boolean;
    passwordRequired: boolean | null;
    passwordInvalid: boolean;
    collection: Collection | null;
    selected: Set<string>;
    probedShareId: string | null;
    settingsHydrated: boolean;
    zipPasswords: Record<string, string>;
    zipLoadingPaths: Set<string>;
    /** original relative path → new basename */
    renames: Record<string, string>;
};

type NewDownloadDraftActions = {
    setUrl: (url: string) => void;
    setPassword: (password: string) => void;
    setSavePath: (savePath: string) => void;
    setCreateCollectionSubfolder: (createCollectionSubfolder: boolean) => void;
    setPasswordRequired: (passwordRequired: boolean | null) => void;
    setPasswordInvalid: (passwordInvalid: boolean) => void;
    setCollection: (collection: Collection | null) => void;
    setSelected: (selected: Set<string>) => void;
    updateSelected: (updater: (selected: Set<string>) => Set<string>) => void;
    setProbedShareId: (probedShareId: string | null) => void;
    setZipPassword: (fileId: string, password: string) => void;
    setZipLoading: (path: string, loading: boolean) => void;
    renameNode: (
        displayPath: string,
        newName: string,
        displayTree: Collection["tree"],
    ) => string | null;
    clearProbeState: () => void;
    resetDraft: () => void;
    hydrateSettings: () => Promise<void>;
};

type NewDownloadDraftStore = NewDownloadDraftState & NewDownloadDraftActions;

const draftDefaults = {
    url: "",
    password: "",
    savePath: "",
    createCollectionSubfolder: true,
    passwordRequired: null,
    passwordInvalid: false,
    collection: null,
    selected: new Set<string>(),
    probedShareId: null,
    settingsHydrated: false,
    zipPasswords: {},
    zipLoadingPaths: new Set<string>(),
    renames: {},
} satisfies NewDownloadDraftState;

export const useNewDownloadDraft = create<NewDownloadDraftStore>((set, get) => ({
    ...draftDefaults,

    setUrl: (url) => set({ url }),

    setPassword: (password) => set({ password }),

    setSavePath: (savePath) => set({ savePath }),

    setCreateCollectionSubfolder: (createCollectionSubfolder) => set({ createCollectionSubfolder }),

    setPasswordRequired: (passwordRequired) => set({ passwordRequired }),

    setPasswordInvalid: (passwordInvalid) => set({ passwordInvalid }),

    setCollection: (collection) =>
        set((state) => ({
            collection,
            renames:
                collection === null || collection.shareId !== state.collection?.shareId
                    ? {}
                    : state.renames,
        })),

    setSelected: (selected) => set({ selected }),

    updateSelected: (updater) => set({ selected: updater(get().selected) }),

    setProbedShareId: (probedShareId) => set({ probedShareId }),

    setZipPassword: (fileId, password) =>
        set({ zipPasswords: { ...get().zipPasswords, [fileId]: password } }),

    setZipLoading: (path, loading) => {
        const next = new Set(get().zipLoadingPaths);
        if (loading) {
            next.add(path);
        } else {
            next.delete(path);
        }
        set({ zipLoadingPaths: next });
    },

    renameNode: (displayPath, newName, displayTree) => {
        const collection = get().collection;
        if (!collection) {
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
            displayPathToOriginal(collection.tree, get().renames, displayPath) ?? displayPath;
        const nextDisplayPath = joinPath(parentPath(displayPath), trimmed);
        const renames = { ...get().renames, [originalPath]: trimmed };
        // Drop no-op entries that restore the original basename
        if (trimmed === basename(originalPath)) {
            delete renames[originalPath];
        }

        set({
            renames,
            selected: rewritePathSet(get().selected, displayPath, nextDisplayPath),
            zipLoadingPaths: rewritePathSet(get().zipLoadingPaths, displayPath, nextDisplayPath),
        });
        return null;
    },

    clearProbeState: () =>
        set({
            password: "",
            passwordRequired: null,
            passwordInvalid: false,
            collection: null,
            selected: new Set(),
            probedShareId: null,
            zipPasswords: {},
            zipLoadingPaths: new Set(),
            renames: {},
        }),

    resetDraft: () =>
        set({
            url: "",
            password: "",
            passwordRequired: null,
            passwordInvalid: false,
            collection: null,
            selected: new Set(),
            probedShareId: null,
            zipPasswords: {},
            zipLoadingPaths: new Set(),
            renames: {},
        }),

    hydrateSettings: async () => {
        if (get().settingsHydrated) return;

        const values = await window.api.invoke("setting:getMany", [
            "general.lastDownloadPath",
            "general.createCollectionSubfolder",
        ]);

        set({
            savePath: values["general.lastDownloadPath"] ?? "",
            createCollectionSubfolder: values["general.createCollectionSubfolder"] ?? true,
            settingsHydrated: true,
        });
    },
}));
