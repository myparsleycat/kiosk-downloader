import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useRemoveTransfer } from "@renderer/hooks/use-remove-transfer";
import type { DownloadFilter, DownloadItem } from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import {
  BrushCleaningIcon,
  DownloadIcon,
  FilterIcon,
  FolderOpenIcon,
  ImportIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ShareIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { DownloadCard } from "./download-card";
import { DownloadDetail } from "./download-detail";

const removeCollectionOptions = {
  removeById: (id: string) => window.api.invoke("download:remove", id),
  errorMessage: "삭제하지 못했습니다",
  dialogTitle: "컬렉션 삭제",
  dialogDescription: "아직 완료되지 않은 전송입니다. 정말 삭제하시겠습니까?",
};

export function DownloadView({
  items,
  focusDownloadId,
  onFocusHandled,
  onNewDownload,
}: {
  items: DownloadItem[];
  focusDownloadId?: string | null;
  onFocusHandled?: () => void;
  onNewDownload: () => void;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(items[0]?.id ?? null);
  const [filter, setFilter] = React.useState<DownloadFilter>("all");

  React.useEffect(() => {
    if (!focusDownloadId) {
      return;
    }
    setSelectedId(focusDownloadId);
    onFocusHandled?.();
  }, [focusDownloadId, onFocusHandled]);

  const filtered = React.useMemo(() => {
    if (filter === "all") return items;
    if (filter === "active")
      return items.filter(
        (i) =>
          i.status === "downloading" ||
          i.status === "inflating" ||
          i.status === "paused" ||
          i.status === "queued" ||
          i.status === "error",
      );
    return items.filter((i) => i.status === "completed");
  }, [items, filter]);

  React.useEffect(() => {
    if (!selectedId || !filtered.some((i) => i.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? null);
    }
  }, [filtered, selectedId]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const { remove, removeCompleted, dialog, removing } =
    useRemoveTransfer<DownloadItem>(removeCollectionOptions);
  const hasCompleted = items.some((item) => item.status === "completed");
  const [pendingAction, setPendingAction] = React.useState(false);

  const runAction = async (action: () => Promise<unknown>, success?: string) => {
    if (pendingAction) return;
    setPendingAction(true);
    try {
      await action();
      if (success) toast.success(success);
    } catch (error) {
      toast.error("작업을 완료하지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(false);
    }
  };

  return (
    <div className="flex h-full">
      <div className="flex w-[320px] min-w-0 shrink-0 flex-col overflow-hidden border-r">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
          <span className="cn-font-heading text-sm font-medium">다운로드</span>
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="outline"
              isLoading={pendingAction}
              onClick={() =>
                runAction(async () => {
                  const item = await window.api.invoke("download:importCollection");
                  if (item) {
                    setSelectedId(item.id);
                    toast.success("컬렉션을 가져왔습니다");
                  }
                })
              }
            >
              <ImportIcon className="size-3" />
              가져오기
            </Button>
            <Button size="xs" variant="default" onClick={onNewDownload}>
              <PlusIcon className="size-3" />
              추가
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-1 border-b px-3 py-1.5">
          <FilterIcon className="size-3 text-muted-foreground" />
          {(["all", "active", "completed"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-2 py-0.5 text-xs transition-colors",
                filter === f
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {f === "all" ? "전체" : f === "active" ? "진행중" : "완료"}
            </button>
          ))}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!hasCompleted || removing}
                  onClick={() => void removeCompleted(items)}
                  className="ml-auto size-6 text-muted-foreground"
                >
                  <BrushCleaningIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipContent>완료된 항목 제거</TooltipContent>
          </Tooltip>
        </div>
        <ScrollArea className="flex-1">
          <div className="flex w-full flex-col gap-2 p-2">
            {filtered.length === 0 ? (
              <div className="mt-8 flex flex-col items-center gap-2 text-sm text-muted-foreground">
                <DownloadIcon className="size-8 opacity-30" />
                항목이 없습니다
              </div>
            ) : (
              filtered.map((item) => (
                <ContextMenu
                  key={item.id}
                  onOpenChange={(open) => {
                    if (open) setSelectedId(item.id);
                  }}
                >
                  <ContextMenuTrigger>
                    <DownloadCard
                      item={item}
                      active={item.id === selectedId}
                      onClick={() => setSelectedId(item.id)}
                    />
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {item.status === "downloading" || item.status === "inflating" ? (
                      <ContextMenuItem
                        onClick={() =>
                          runAction(() => window.api.invoke("download:pauseCollection", item.id))
                        }
                      >
                        <PauseIcon />
                        일시정지
                      </ContextMenuItem>
                    ) : item.status === "paused" ||
                      item.status === "queued" ||
                      item.status === "error" ? (
                      <ContextMenuItem
                        onClick={() =>
                          runAction(
                            () =>
                              window.api.invoke("download:resumeCollection", item.id, {
                                force: item.status === "error",
                              }),
                            item.status === "error" ? "재시도를 시작했습니다" : undefined,
                          )
                        }
                      >
                        <PlayIcon />
                        {item.status === "error" ? "재시도" : "시작"}
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuItem
                      onClick={() =>
                        runAction(() => window.api.invoke("download:openFolder", item.id))
                      }
                    >
                      <FolderOpenIcon />
                      폴더 열기
                    </ContextMenuItem>
                    {item.status !== "completed" && (
                      <ContextMenuItem
                        onClick={() =>
                          runAction(async () => {
                            const result = await window.api.invoke(
                              "download:exportCollection",
                              item.id,
                            );
                            if (result) {
                              toast.success("컬렉션을 내보냈습니다");
                            }
                          })
                        }
                      >
                        <ShareIcon />
                        내보내기
                      </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      disabled={removing}
                      onClick={() => remove(item)}
                    >
                      <Trash2Icon />
                      삭제
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex-1">
        <DownloadDetail item={selected} onRemove={remove} removing={removing} />
      </div>
      {dialog}
    </div>
  );
}
