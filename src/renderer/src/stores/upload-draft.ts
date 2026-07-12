import { validateRenameName } from "@shared/name-validation";
import type { UploadTreeFile } from "@shared/types";
import { create } from "zustand";

const DAY = 24 * 60 * 60 * 1000;
const MAX_EXPIRY_DAYS = 30;
const DEFAULT_EXPIRY_DAYS = 7;

export function clampExpiry(ms: number): number {
    const now = Date.now();
    return Math.min(Math.max(ms, now), now + MAX_EXPIRY_DAYS * DAY);
}

type UploadDraftState = {
    files: UploadTreeFile[];
    name: string;
    description: string;
    password: string;
    expiresAt: number;
};

type UploadDraftActions = {
    addFiles: (files: UploadTreeFile[]) => void;
    removeFile: (path: string) => void;
    clearFiles: () => void;
    renameFile: (oldPath: string, newName: string) => string | null;
    setName: (name: string) => void;
    setDescription: (description: string) => void;
    setPassword: (password: string) => void;
    setExpiresAt: (ms: number) => void;
    resetDraft: () => void;
};

type UploadDraftStore = UploadDraftState & UploadDraftActions;

const draftDefaults = {
    files: [],
    name: "",
    description: "",
    password: "",
    expiresAt: clampExpiry(Date.now() + DEFAULT_EXPIRY_DAYS * DAY),
} satisfies UploadDraftState;

export const useUploadDraft = create<UploadDraftStore>((set, get) => ({
    ...draftDefaults,

    addFiles: (incoming) => {
        const existing = new Map(get().files.map((f) => [f.path, f]));
        for (const file of incoming) {
            existing.set(file.path, file);
        }
        const files = [...existing.values()];
        const name = get().name;
        set({
            files,
            name: name.trim() === "" && incoming.length > 0 ? incoming[0].path.split("/")[0] : name,
        });
    },

    removeFile: (path) => {
        const prefix = `${path}/`;
        const files = get().files.filter((f) => f.path !== path && !f.path.startsWith(prefix));
        void window.api.invoke("upload:removeDraftSources", [path]);
        set({ files });
    },

    renameFile: (oldPath, newName) => {
        const error = validateRenameName(newName);
        if (error) return error;

        const slashIndex = oldPath.lastIndexOf("/");
        const parent = slashIndex === -1 ? "" : oldPath.slice(0, slashIndex);
        const newPath = parent ? `${parent}/${newName}` : newName;

        const files = get().files;
        const prefix = `${oldPath}/`;
        const conflict = files.some((f) => f.path === newPath || f.path.startsWith(`${newPath}/`));
        if (conflict) return "같은 위치에 이미 존재하는 이름입니다.";

        const updated = files.map((f) => {
            if (f.path === oldPath) {
                return { ...f, path: newPath, name: newName };
            }
            if (f.path.startsWith(prefix)) {
                return { ...f, path: `${newPath}${f.path.slice(oldPath.length)}` };
            }
            return f;
        });

        void window.api.invoke("upload:renameDraftSource", oldPath, newPath);
        set({ files: updated });
        return null;
    },

    clearFiles: () => {
        void window.api.invoke("upload:clearDraftSources");
        set({ files: [] });
    },

    setName: (name) => set({ name }),
    setDescription: (description) => set({ description }),
    setPassword: (password) => set({ password }),
    setExpiresAt: (expiresAt) => set({ expiresAt: clampExpiry(expiresAt) }),

    resetDraft: () => {
        void window.api.invoke("upload:clearDraftSources");
        set({
            files: [],
            name: "",
            description: "",
            password: "",
            expiresAt: clampExpiry(Date.now() + DEFAULT_EXPIRY_DAYS * DAY),
        });
    },
}));
