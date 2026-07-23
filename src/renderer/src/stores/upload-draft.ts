import {
    basename,
    hasUploadPathConflict,
    joinPath,
    parentPath,
    renameUploadFiles,
    validateNodeName,
} from "@shared/tree-rename";
import type { UploadMode, UploadTreeFile } from "@shared/types";
import { create } from "zustand";

const DAY = 24 * 60 * 60 * 1000;
const MAX_EXPIRY_DAYS = 30;
const DEFAULT_EXPIRY_DAYS = 7;

export function clampExpiry(ms: number): number {
    const now = Date.now();
    return Math.min(Math.max(ms, now), now + MAX_EXPIRY_DAYS * DAY);
}

export function mergeDateAndTime(date: Date, time: string): number {
    const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map((part) => {
        const value = Number(part);
        return Number.isNaN(value) ? 0 : value;
    });
    const merged = new Date(date);
    merged.setHours(hours, minutes, seconds, 0);
    return clampExpiry(merged.getTime());
}

type UploadDraftState = {
    files: UploadTreeFile[];
    name: string;
    description: string;
    password: string;
    expiresAt: number;
    mode: UploadMode;
};

type UploadDraftActions = {
    addFiles: (files: UploadTreeFile[]) => void;
    removeFile: (path: string) => void;
    removeFiles: (paths: string[]) => void;
    renameFile: (path: string, newName: string) => Promise<string | null>;
    clearFiles: () => void;
    setName: (name: string) => void;
    setDescription: (description: string) => void;
    setPassword: (password: string) => void;
    setExpiresAt: (ms: number) => void;
    setMode: (mode: UploadMode) => void;
    resetDraft: () => void;
};

type UploadDraftStore = UploadDraftState & UploadDraftActions;

const draftDefaults = {
    files: [],
    name: "",
    description: "",
    password: "",
    expiresAt: clampExpiry(Date.now() + DEFAULT_EXPIRY_DAYS * DAY),
    mode: "standard",
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
        get().removeFiles([path]);
    },

    removeFiles: (paths) => {
        if (paths.length === 0) return;
        const files = get().files.filter(
            (f) => !paths.some((path) => f.path === path || f.path.startsWith(`${path}/`)),
        );
        void window.api.invoke("upload:removeDraftSources", paths);
        set({ files });
    },

    renameFile: async (path, newName) => {
        const trimmed = newName.trim();
        const validationError = validateNodeName(trimmed);
        if (validationError) {
            return validationError;
        }
        if (basename(path) === trimmed) {
            return null;
        }
        const files = get().files;
        if (hasUploadPathConflict(files, path, trimmed)) {
            return "같은 위치에 동일한 이름이 이미 있습니다.";
        }
        const toPath = joinPath(parentPath(path), trimmed);

        try {
            await window.api.invoke("upload:renameDraftSources", { from: path, to: toPath });
        } catch (error) {
            return error instanceof Error ? error.message : "이름 변경에 실패했습니다.";
        }

        const nextFiles = renameUploadFiles(get().files, path, trimmed);
        const currentName = get().name;
        const topSegment = path.split("/")[0] ?? "";
        const isRootRename = parentPath(path) === "";
        const nextName =
            currentName.trim() === ""
                ? (nextFiles[0]?.path.split("/")[0] ?? currentName)
                : isRootRename && currentName === topSegment
                  ? trimmed
                  : currentName;

        set({ files: nextFiles, name: nextName });
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
    setMode: (mode) => set({ mode }),

    resetDraft: () => {
        void window.api.invoke("upload:clearDraftSources");
        set({
            files: [],
            name: "",
            description: "",
            password: "",
            expiresAt: clampExpiry(Date.now() + DEFAULT_EXPIRY_DAYS * DAY),
            mode: "standard",
        });
    },
}));
