import { create } from "zustand";

export type AppTab = "downloads" | "new" | "uploads" | "new-upload" | "settings";
export type SettingsSection = "general" | "collection" | "transfer" | "account" | "advanced";

type AppNavigationStore = {
    tab: AppTab;
    settingsSection: SettingsSection;
    setTab: (tab: AppTab) => void;
    setSettingsSection: (section: SettingsSection) => void;
    openSettings: (section?: SettingsSection) => void;
};

export const useAppNavigation = create<AppNavigationStore>((set) => ({
    tab: "downloads",
    settingsSection: "general",
    setTab: (tab) => set({ tab }),
    setSettingsSection: (settingsSection) => set({ settingsSection }),
    openSettings: (settingsSection = "general") => set({ tab: "settings", settingsSection }),
}));
