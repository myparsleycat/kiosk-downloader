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

export type DownloadPreparationState =
    | { status: "idle" }
    | { status: "preparing" }
    | { status: "passwordRequired"; invalid: boolean }
    | { status: "ready"; draftId: string; collection: Collection }
    | { status: "error"; message: string };

type NewDownloadDraftState = {
    url: string;
    password: string;
    savePath: string;
    createCollectionSubfolder: boolean;
    asciiFilenames: boolean;
    preparation: DownloadPreparationState;
    selected: Set<string>;
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
    setPreparation: (preparation: DownloadPreparationState) => void;
    setSelected: (selected: Set<string>) => void;
    updateSelected: (updater: (selected: Set<string>) => Set<string>) => void;
    setZipPassword: (fileId: string, password: string) => void;
    setZipLoading: (path: string, loading: boolean) => void;
    renameNode: (
        displayPath: string,
        newName: string,
        displayTree: Collection["tree"],
    ) => string | null;
    clearPreparation: () => void;
    resetDraft: () => void;
    hydrateSettings: () => Promise<void>;
};

type NewDownloadDraftStore = NewDownloadDraftState & NewDownloadDraftActions;

const draftDefaults = {
    url: "",
    password: "",
    savePath: "",
    createCollectionSubfolder: true,
    asciiFilenames: false,
    preparation: { status: "idle" },
    selected: new Set<string>(),
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

    setPreparation: (preparation) =>
        set((state) => ({
            preparation,
            renames:
                preparation.status !== "ready" ||
                preparation.collection.shareId !==
                    (state.preparation.status === "ready"
                        ? state.preparation.collection.shareId
                        : undefined)
                    ? {}
                    : state.renames,
        })),

    setSelected: (selected) => set({ selected }),

    updateSelected: (updater) => set({ selected: updater(get().selected) }),

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
        const preparation = get().preparation;
        const collection = preparation.status === "ready" ? preparation.collection : null;
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

    clearPreparation: () =>
        set({
            password: "",
            preparation: { status: "idle" },
            selected: new Set(),
            zipPasswords: {},
            zipLoadingPaths: new Set(),
            renames: {},
        }),

    resetDraft: () =>
        set({
            url: "",
            password: "",
            preparation: { status: "idle" },
            selected: new Set(),
            zipPasswords: {},
            zipLoadingPaths: new Set(),
            renames: {},
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
