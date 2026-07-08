import { cn } from "@renderer/lib/utils";
import * as React from "react";
import { toast } from "sonner";

import type { DownloadItem } from "./lib/types";

import { DownloadView } from "./components/downloads/download-view";
import { NewDownloadView } from "./components/new-download/new-download-view";
import { SettingsView } from "./components/settings/settings-view";
import { ThemeBridge } from "./components/theme-bridge";
import { ThemeProvider } from "./components/theme-provider";
import { Toaster } from "./components/ui/sonner";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { TooltipProvider } from "./components/ui/tooltip";
import { useTitleBarOverlay } from "./hooks/use-title-bar-overlay";
import { useDownloadTreeExpanded } from "./stores/download-tree-expanded";

export function RootProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ThemeBridge />
      <Toaster position="bottom-right" richColors closeButton />
      <TooltipProvider>{children}</TooltipProvider>
    </ThemeProvider>
  );
}

type TabValue = "downloads" | "new" | "settings";

const isDarwin = window.electron.process.platform === "darwin";

function MainComponent() {
  const [tab, setTab] = React.useState<TabValue>("downloads");
  const [downloads, setDownloads] = React.useState<DownloadItem[]>([]);
  const [focusDownloadId, setFocusDownloadId] = React.useState<string | null>(null);

  useTitleBarOverlay();

  React.useEffect(() => {
    let mounted = true;

    window.api
      .invoke("download:list")
      .then((items) => {
        if (mounted) setDownloads(items);
      })
      .catch((error) => {
        toast.error("다운로드 목록을 불러오지 못했습니다", {
          description: error instanceof Error ? error.message : String(error),
        });
      });

    const offUpdate = window.api.on("download:update", (items) => {
      setDownloads(items);
    });
    const offItem = window.api.on("download:item-update", (item) => {
      setDownloads((prev) => {
        const index = prev.findIndex((entry) => entry.id === item.id);
        if (index === -1) return [item, ...prev];
        const next = [...prev];
        next[index] = item;
        return next;
      });
    });
    const offToast = window.api.on("fn:toast", (message, data) => {
      toast(message, data);
    });

    return () => {
      mounted = false;
      offUpdate();
      offItem();
      offToast();
    };
  }, []);

  return (
    <main className="flex h-screen flex-col">
      {/* top tabs */}
      <div className={cn("titlebar flex items-center py-2 pr-2", isDarwin ? "pl-21" : "pl-2")}>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as TabValue)}
          className="w-full flex-row gap-0 h-6"
        >
          <TabsList className="h-6 no-drag p-0 bg-transparent">
            <TabsTrigger value="downloads">다운로드</TabsTrigger>
            <TabsTrigger value="new">새 다운로드</TabsTrigger>
            <TabsTrigger value="settings">설정</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="shrink-0 border-b" />

      {/* view section */}
      <div className="flex-1 overflow-hidden">
        {tab === "downloads" && (
          <DownloadView
            items={downloads}
            focusDownloadId={focusDownloadId}
            onFocusHandled={() => setFocusDownloadId(null)}
            onNewDownload={() => setTab("new")}
          />
        )}
        {tab === "new" && (
          <NewDownloadView
            onCreated={(downloadId) => {
              useDownloadTreeExpanded.getState().resetDownload(downloadId);
              setFocusDownloadId(downloadId);
              setTab("downloads");
            }}
          />
        )}
        {tab === "settings" && <SettingsView />}
      </div>
    </main>
  );
}

function App(): React.JSX.Element {
  return (
    <RootProvider>
      <MainComponent />
    </RootProvider>
  );
}

export default App;
