import { create } from "zustand";

type DownloadTreeExpandedState = {
    expandedByDownload: Record<string, Set<string>>;
    isExpanded: (downloadId: string, dirKey: string) => boolean;
    setExpanded: (downloadId: string, dirKey: string, expanded: boolean) => void;
    toggleExpanded: (downloadId: string, dirKey: string) => void;
    resetDownload: (downloadId: string) => void;
};

export const useDownloadTreeExpanded = create<DownloadTreeExpandedState>((set, get) => ({
    expandedByDownload: {},

    isExpanded: (downloadId, dirKey) => get().expandedByDownload[downloadId]?.has(dirKey) ?? false,

    setExpanded: (downloadId, dirKey, expanded) => {
        set((state) => {
            const expandedByDownload = { ...state.expandedByDownload };
            const paths = new Set(expandedByDownload[downloadId] ?? []);
            if (expanded) {
                paths.add(dirKey);
            } else {
                paths.delete(dirKey);
            }
            expandedByDownload[downloadId] = paths;
            return { expandedByDownload };
        });
    },

    toggleExpanded: (downloadId, dirKey) => {
        get().setExpanded(downloadId, dirKey, !get().isExpanded(downloadId, dirKey));
    },

    resetDownload: (downloadId) => {
        set((state) => {
            if (!(downloadId in state.expandedByDownload)) {
                return state;
            }
            const expandedByDownload = { ...state.expandedByDownload };
            delete expandedByDownload[downloadId];
            return { expandedByDownload };
        });
    },
}));
