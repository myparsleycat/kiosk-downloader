import { cn } from "@renderer/lib/utils";
import { tryDecodeShareUrlBase64, tryParseDownloadUrl } from "@shared/share-url";
import type { DownloadItem, UploadItem } from "@shared/types";
import {
  DownloadIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlusIcon,
  SettingsIcon,
  UploadIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { DownloadView } from "./components/downloads/download-view";
import { NewDownloadView } from "./components/new-download/new-download-view";
import { SettingsView } from "./components/settings/settings-view";
import { ThemeBridge } from "./components/theme-bridge";
import { ThemeProvider } from "./components/theme-provider";
import { Button } from "./components/ui/button";
import { Toaster } from "./components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { UpdateAlertDialog } from "./components/update-alert-dialog";
import { UploadList } from "./components/uploads/upload-list";
import { UploadView } from "./components/uploads/upload-view";
import { useTitleBarOverlay } from "./hooks/use-title-bar-overlay";
import {
  applyPendingItems,
  mergeProgressPatchIntoItems,
  upsertItem,
} from "./lib/merge-progress-patch";
import { useDownloadTreeExpanded } from "./stores/download-tree-expanded";
import { useNewDownloadDraft } from "./stores/new-download-draft";
import { useUpdaterStore } from "./stores/updater";

export function RootProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ThemeBridge />
      <Toaster position="bottom-right" richColors closeButton />
      <TooltipProvider>
        <UpdateAlertDialog />
        {children}
      </TooltipProvider>
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

  const downloadActivity = React.useMemo(
    () =>
      downloads.some((item) => item.status === "downloading" || item.status === "inflating")
        ? "active"
        : downloads.some((item) => item.status === "paused")
          ? "paused"
          : "idle",
    [downloads],
  );
  const uploadActivity = React.useMemo(
    () =>
      uploads.some((item) => item.status === "uploading")
        ? "active"
        : uploads.some((item) => item.status === "paused")
          ? "paused"
          : "idle",
    [uploads],
  );

  useTitleBarOverlay();

  const updateAvailable = useUpdaterStore((state) => state.updateAvailable);
  const updateDownloaded = useUpdaterStore((state) => state.updateDownloaded);
  const shouldPromptForUpdate = useUpdaterStore((state) => state.shouldPromptForUpdate);
  const setShouldPromptForUpdate = useUpdaterStore((state) => state.setShouldPromptForUpdate);
  const updaterMode = useUpdaterStore((state) => state.mode);
  const updaterStrategy = useUpdaterStore((state) => state.strategy);
  const updaterDownloading = useUpdaterStore((state) => state.isDownloading);
  const [isUpdateActionPending, setIsUpdateActionPending] = React.useState(false);

  const shouldOfferManualDownload =
    updateAvailable &&
    !updateDownloaded &&
    updaterStrategy === "nsis" &&
    (shouldPromptForUpdate || updaterMode === "notify");
  const shouldOfferManualPage =
    updateAvailable && updaterStrategy === "manual" && !shouldPromptForUpdate;
  const shouldShowUpdateButton =
    shouldOfferManualDownload || updateDownloaded || shouldOfferManualPage || shouldPromptForUpdate;

  React.useEffect(() => {
    const setUpdaterStatus = useUpdaterStore.getState().setUpdaterStatus;
    const setAppVersion = useUpdaterStore.getState().setAppVersion;

    void window.api
      .invoke("util:getAppStatus")
      .then((status) => setAppVersion(status.version))
      .catch(() => {});

    void window.api
      .invoke("updater:getStatus")
      .then(setUpdaterStatus)
      .catch(() => {});

    const offStatus = window.api.on("updater:status-changed", setUpdaterStatus);
    const offAvailable = window.api.on("updater:update-available", () => {
      void window.api.invoke("updater:getStatus").then(setUpdaterStatus);
    });
    const offDownloaded = window.api.on("updater:update-downloaded", () => {
      void window.api.invoke("updater:getStatus").then(setUpdaterStatus);
    });

    const onFocus = () => {
      void window.api.invoke("updater:getStatus").then(setUpdaterStatus);
    };
    window.addEventListener("focus", onFocus);

    return () => {
      offStatus();
      offAvailable();
      offDownloaded();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

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
      if (!tryParseDownloadUrl(resolved.trim())) return;

      e.preventDefault();
      useNewDownloadDraft.getState().setUrl(resolved.trim());
      setTab("new");
    };

    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  React.useEffect(() => {
    let mounted = true;
    let initialized = false;
    const pendingItems = new Map<string, DownloadItem>();

    const applyFullItems = (items: DownloadItem[]) => {
      if (initialized) {
        setDownloads(items);
        return;
      }
      for (const item of items) pendingItems.set(item.id, item);
    };

    const applyFullItem = (item: DownloadItem) => {
      if (initialized) {
        setDownloads((prev) => upsertItem(prev, item));
        return;
      }
      pendingItems.set(item.id, item);
    };

    window.api
      .invoke("download:list")
      .then((items) => {
        if (!mounted) return;
        initialized = true;
        setDownloads(applyPendingItems(items, pendingItems));
        pendingItems.clear();
      })
      .catch((error) => {
        toast.error("다운로드 목록을 불러오지 못했습니다", {
          description: error instanceof Error ? error.message : String(error),
        });
      });

    const offUpdate = window.api.on("download:update", (items) => {
      applyFullItems(items);
    });
    const offItem = window.api.on("download:item-update", (item) => {
      applyFullItem(item);
    });
    const offProgress = window.api.on("download:progress-update", (patch) => {
      if (!initialized) return;
      React.startTransition(() => {
        setDownloads((prev) => mergeProgressPatchIntoItems(prev, patch));
      });
    });
    const offToast = window.api.on("fn:toast", (message, data) => {
      toast(message, data);
    });

    return () => {
      mounted = false;
      offUpdate();
      offItem();
      offProgress();
      offToast();
    };
  }, []);

  React.useEffect(() => {
    let mounted = true;
    let initialized = false;
    const pendingItems = new Map<string, UploadItem>();

    const applyFullItems = (items: UploadItem[]) => {
      if (initialized) {
        setUploads(items);
        return;
      }
      for (const item of items) pendingItems.set(item.id, item);
    };

    const applyFullItem = (item: UploadItem) => {
      if (initialized) {
        setUploads((prev) => upsertItem(prev, item));
        return;
      }
      pendingItems.set(item.id, item);
    };

    const offUpdate = window.api.on("upload:update", (items) => {
      applyFullItems(items);
    });
    const offItem = window.api.on("upload:item-update", (item) => {
      applyFullItem(item);
    });
    const offProgress = window.api.on("upload:progress-update", (patch) => {
      if (!initialized) return;
      React.startTransition(() => {
        setUploads((prev) => mergeProgressPatchIntoItems(prev, patch));
      });
    });

    window.api
      .invoke("upload:list")
      .then((items) => {
        if (!mounted) return;
        initialized = true;
        setUploads(applyPendingItems(items, pendingItems));
        pendingItems.clear();
      })
      .catch((error) => {
        toast.error("업로드 목록을 불러오지 못했습니다", {
          description: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      mounted = false;
      offUpdate();
      offItem();
      offProgress();
    };
  }, []);

  return (
    <main className="flex h-screen flex-col">
      <div
        className={cn(
          "titlebar flex items-center gap-2 py-2 pr-2 no-drag",
          isDarwin ? "pl-21" : "pl-2",
        )}
      >
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTab("downloads")}
            className={cn(
              "h-6 gap-1 px-2 text-xs",
              tab === "downloads" || tab === "new"
                ? "bg-muted text-foreground"
                : "text-foreground/60",
            )}
          >
            {downloadActivity === "active" ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : downloadActivity === "paused" ? (
              <PauseIcon className="size-3.5" />
            ) : (
              <DownloadIcon className="size-3.5" />
            )}
            다운로드
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setTab("new")}
                  className={cn(
                    "h-6 w-6",
                    tab === "new" ? "bg-muted text-foreground" : "text-foreground/60",
                  )}
                >
                  <PlusIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipContent>새 다운로드</TooltipContent>
          </Tooltip>
        </div>

        <div className="h-4 w-px bg-border" />

        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTab("uploads")}
            className={cn(
              "h-6 gap-1 px-2 text-xs",
              tab === "uploads" || tab === "new-upload"
                ? "bg-muted text-foreground"
                : "text-foreground/60",
            )}
          >
            {uploadActivity === "active" ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : uploadActivity === "paused" ? (
              <PauseIcon className="size-3.5" />
            ) : (
              <UploadIcon className="size-3.5" />
            )}
            업로드
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setTab("new-upload")}
                  className={cn(
                    "h-6 w-6",
                    tab === "new-upload" ? "bg-muted text-foreground" : "text-foreground/60",
                  )}
                >
                  <PlusIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipContent>새 업로드</TooltipContent>
          </Tooltip>
        </div>

        <div className="h-4 w-px bg-border" />

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTab("settings")}
          className={cn(
            "h-6 gap-1 px-2 text-xs",
            tab === "settings" ? "bg-muted text-foreground" : "text-foreground/60",
          )}
        >
          <SettingsIcon className="size-3.5" />
          설정
        </Button>

        {shouldShowUpdateButton && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="ml-auto h-6 px-2 text-[11.5px]"
            isLoading={isUpdateActionPending || updaterDownloading}
            onClick={() => {
              if (updateDownloaded || (updaterStrategy === "manual" && updateAvailable)) {
                setShouldPromptForUpdate(true);
                return;
              }
              if (shouldOfferManualDownload) {
                setIsUpdateActionPending(true);
                void window.api
                  .invoke("updater:downloadUpdate")
                  .catch((error) => {
                    toast.error("업데이트를 다운로드하지 못했습니다", {
                      description: error instanceof Error ? error.message : String(error),
                    });
                  })
                  .finally(() => setIsUpdateActionPending(false));
              }
            }}
          >
            {updateDownloaded
              ? "업데이트 확인"
              : updaterStrategy === "manual"
                ? "업데이트 확인"
                : "업데이트 다운로드"}
          </Button>
        )}
      </div>
      <div className="shrink-0 border-b" />

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
