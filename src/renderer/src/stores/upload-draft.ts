import type { UploadTreeFile } from "@shared/types";
import { create } from "zustand";

export type ExpiryPreset = "1d" | "7d" | "30d" | "eternal";

type UploadDraftState = {
    files: UploadTreeFile[];
    name: string;
    description: string;
    password: string;
    expiryPreset: ExpiryPreset;
    selected: Set<string>;
};

type UploadDraftActions = {
    addFiles: (files: UploadTreeFile[]) => void;
    removeFile: (path: string) => void;
    clearFiles: () => void;
    setName: (name: string) => void;
    setDescription: (description: string) => void;
    setPassword: (password: string) => void;
    setExpiryPreset: (preset: ExpiryPreset) => void;
    updateSelected: (updater: (selected: Set<string>) => Set<string>) => void;
    resetDraft: () => void;
};

type UploadDraftStore = UploadDraftState & UploadDraftActions;

const draftDefaults = {
    files: [],
    name: "",
    description: "",
    password: "",
    expiryPreset: "7d" as ExpiryPreset,
    selected: new Set<string>(),
} satisfies UploadDraftState;

export const useUploadDraft = create<UploadDraftStore>((set, get) => ({
    ...draftDefaults,

    addFiles: (incoming) => {
        const existing = new Map(get().files.map((f) => [f.path, f]));
        for (const file of incoming) {
            existing.set(file.path, file);
        }
        const files = [...existing.values()];
        const selected = new Set(get().selected);
        for (const file of incoming) {
            selected.add(file.path);
        }
        set({ files, selected });
    },

    removeFile: (path) => {
        const files = get().files.filter((f) => f.path !== path);
        const selected = new Set(get().selected);
        selected.delete(path);
        set({ files, selected });
    },

    clearFiles: () => set({ files: [], selected: new Set() }),

    setName: (name) => set({ name }),
    setDescription: (description) => set({ description }),
    setPassword: (password) => set({ password }),
    setExpiryPreset: (expiryPreset) => set({ expiryPreset }),

    updateSelected: (updater) => set({ selected: updater(get().selected) }),

    resetDraft: () =>
        set({
            files: [],
            name: "",
            description: "",
            password: "",
            expiryPreset: "7d",
            selected: new Set(),
        }),
}));

export function resolveExpiryTimestamp(preset: ExpiryPreset): number {
    const now = Date.now();
    if (preset === "eternal") {
        return now;
    }

    const DAY = 24 * 60 * 60 * 1000;
    const days = preset === "1d" ? 1 : preset === "7d" ? 7 : 30;
    const ms = now + days * DAY;
    return Math.min(Math.max(ms, now), now + 30 * DAY);
}
