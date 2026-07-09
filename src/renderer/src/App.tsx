import { cn } from "@renderer/lib/utils";
import { tryDecodeShareUrlBase64, tryParseShareUrl } from "@shared/share-url";
import type { UploadItem } from "@shared/types";
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
import { UploadList } from "./components/uploads/upload-list";
import { UploadView } from "./components/uploads/upload-view";
import { useTitleBarOverlay } from "./hooks/use-title-bar-overlay";
import { useDownloadTreeExpanded } from "./stores/download-tree-expanded";
import { useNewDownloadDraft } from "./stores/new-download-draft";

export function RootProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ThemeBridge />
      <Toaster position="bottom-right" richColors closeButton />
      <TooltipProvider>{children}</TooltipProvider>
    </ThemeProvider>
  );
}

type TabValue = "downloads" | "new" | "uploads" | "new-upload" | "settings";

const isDarwin = window.electron.process.platform === "darwin";

function MainComponent() {
  const [tab, setTab] = React.useState<TabValue>("downloads");
  const [downloads, setDownloads] = React.useState<DownloadItem[]>([]);
  const [uploads, setUploads] = React.useState<UploadItem[]>([]);
  const [focusDownloadId, setFocusDownloadId] = React.useState<string | null>(null);
  const [focusUploadId, setFocusUploadId] = React.useState<string | null>(null);

  useTitleBarOverlay();

  React.useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      const text = e.clipboardData?.getData("text") ?? "";
      const resolved = tryDecodeShareUrlBase64(text) ?? text;
      if (!tryParseShareUrl(resolved.trim())) return;

      e.preventDefault();
      useNewDownloadDraft.getState().setUrl(resolved.trim());
      setTab("new");
    };

    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

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

  React.useEffect(() => {
    let mounted = true;

    window.api
      .invoke("upload:list")
      .then((items) => {
        if (mounted) setUploads(items);
      })
      .catch((error) => {
        toast.error("업로드 목록을 불러오지 못했습니다", {
          description: error instanceof Error ? error.message : String(error),
        });
      });

    const offUpdate = window.api.on("upload:update", (items) => {
      setUploads(items);
    });
    const offItem = window.api.on("upload:item-update", (item) => {
      setUploads((prev) => {
        const index = prev.findIndex((entry) => entry.id === item.id);
        if (index === -1) return [item, ...prev];
        const next = [...prev];
        next[index] = item;
        return next;
      });
    });

    return () => {
      mounted = false;
      offUpdate();
      offItem();
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
            <TabsTrigger value="uploads">업로드</TabsTrigger>
            <TabsTrigger value="new-upload">새 업로드</TabsTrigger>
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
        {tab === "uploads" && (
          <UploadList
            items={uploads}
            focusUploadId={focusUploadId}
            onFocusHandled={() => setFocusUploadId(null)}
            onNewUpload={() => setTab("new-upload")}
          />
        )}
        {tab === "new-upload" && (
          <UploadView
            onCreated={(uploadId) => {
              setFocusUploadId(uploadId);
              setTab("uploads");
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
