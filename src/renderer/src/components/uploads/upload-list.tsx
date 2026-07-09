import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { cn } from "@renderer/lib/utils";
import type { UploadItem } from "@shared/types";
import { formatSize, formatSpeed, formatTime } from "@shared/utils";
import {
  ClockIcon,
  CopyIcon,
  FilterIcon,
  FolderIcon,
  LinkIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  TimerIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { UploadCard } from "./upload-card";

type UploadFilter = "all" | "active" | "completed";

export function UploadList({
  items,
  focusUploadId,
  onFocusHandled,
  onNewUpload,
}: {
  items: UploadItem[];
  focusUploadId?: string | null;
  onFocusHandled?: () => void;
  onNewUpload: () => void;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(items[0]?.id ?? null);
  const [filter, setFilter] = React.useState<UploadFilter>("all");
  const [removing, setRemoving] = React.useState(false);

  React.useEffect(() => {
    if (!focusUploadId) return;
    setSelectedId(focusUploadId);
    onFocusHandled?.();
  }, [focusUploadId, onFocusHandled]);

  const filtered = React.useMemo(() => {
    if (filter === "all") return items;
    if (filter === "active")
      return items.filter(
        (i) =>
          i.status === "uploading" ||
          i.status === "paused" ||
          i.status === "queued" ||
          i.status === "error",
      );
    return items.filter((i) => i.status === "completed");
  }, [items, filter]);

  React.useEffect(() => {
    if (!selectedId) {
      setSelectedId(filtered[0]?.id ?? null);
    } else if (!filtered.some((i) => i.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? null);
    }
  }, [filtered, selectedId]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  const runAction = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) toast.success(success);
    } catch (error) {
      toast.error("작업을 완료하지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleRemove = async (item: UploadItem) => {
    setRemoving(true);
    try {
      await window.api.invoke("upload:remove", item.id);
    } catch (error) {
      toast.error("삭제하지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRemoving(false);
    }
  };

  const handleCopyLink = async (item: UploadItem) => {
    if (!item.shareLink) {
      toast.error("아직 공유 링크가 생성되지 않았습니다");
      return;
    }
    try {
      await window.api.invoke("upload:copyLink", item.id);
      toast.success("링크를 복사했습니다");
    } catch (error) {
      toast.error("복사하지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="flex h-full">
      <div className="flex w-[320px] min-w-0 shrink-0 flex-col overflow-hidden border-r">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
          <span className="cn-font-heading text-sm font-medium">업로드</span>
          <Button size="xs" variant="default" onClick={onNewUpload}>
            <PlusIcon className="size-3" />
            추가
          </Button>
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
        </div>
        <ScrollArea className="flex-1">
          <div className="flex w-full flex-col gap-2 p-2">
            {filtered.length === 0 ? (
              <div className="mt-8 flex flex-col items-center gap-2 text-sm text-muted-foreground">
                <UploadIcon className="size-8 opacity-30" />
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
                    <UploadCard
                      item={item}
                      active={item.id === selectedId}
                      onClick={() => setSelectedId(item.id)}
                    />
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {item.status === "uploading" ? (
                      <ContextMenuItem
                        onClick={() => runAction(() => window.api.invoke("upload:pause", item.id))}
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
                              window.api.invoke("upload:resume", item.id, {
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
                    {item.shareLink && (
                      <ContextMenuItem onClick={() => handleCopyLink(item)}>
                        <CopyIcon />
                        링크 복사
                      </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      disabled={removing}
                      onClick={() => handleRemove(item)}
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
        <UploadDetail
          item={selected}
          onRemove={handleRemove}
          removing={removing}
          onCopyLink={handleCopyLink}
        />
      </div>
    </div>
  );
}

function UploadDetail({
  item,
  onRemove,
  removing,
  onCopyLink,
}: {
  item: UploadItem | null;
  onRemove: (item: UploadItem) => void;
  removing: boolean;
  onCopyLink: (item: UploadItem) => void;
}) {
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);

  const runAction = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setPendingAction(key);
    try {
      await action();
      if (success) toast.success(success);
    } catch (error) {
      toast.error("작업을 완료하지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPendingAction(null);
    }
  };

  if (!item) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        왼쪽에서 업로드를 선택하세요
      </div>
    );
  }

  const { progress, status } = item;
  const allProgress = Object.values(progress);
  const totalBytes = allProgress.reduce((a, p) => a + p.size, 0);
  const uploadedBytes = allProgress.reduce((a, p) => a + p.uploaded, 0);
  const pct = totalBytes > 0 ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 0;
  const fileCount = allProgress.length;
  const completedCount = allProgress.filter((p) => p.status === "completed").length;
  const speedLabel = status === "uploading" ? formatSpeed(item.speedBps) : null;
  const elapsedLabel =
    item.elapsedMs != null && item.elapsedMs > 0
      ? formatTime(item.elapsedMs / 1000, navigator.language)
      : null;

  const expiresLabel = item.eternal
    ? "만료 없음"
    : new Date(item.expires).toLocaleString("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-3 border-b p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="cn-font-heading truncate text-base font-medium">{item.name}</h2>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              {item.shareLink ? (
                <span className="flex items-center gap-1 font-mono">
                  <LinkIcon className="size-3" />
                  {item.shareLink}
                </span>
              ) : (
                <span className="text-muted-foreground/60">링크 생성 대기 중</span>
              )}
              <span className="flex items-center gap-1">
                <ClockIcon className="size-3" />
                만료 {expiresLabel}
              </span>
              {item.passwordProtected && (
                <span className="flex items-center gap-1">
                  <LockIcon className="size-3" />
                  비밀번호
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {status === "uploading" ? (
              <Button
                variant="outline"
                size="sm"
                isLoading={pendingAction === "pause"}
                onClick={() => runAction("pause", () => window.api.invoke("upload:pause", item.id))}
              >
                <PauseIcon className="size-3.5" />
                일시정지
              </Button>
            ) : status === "paused" || status === "queued" || status === "error" ? (
              <Button
                variant="outline"
                size="sm"
                isLoading={pendingAction === "resume"}
                onClick={() =>
                  runAction(
                    "resume",
                    () =>
                      window.api.invoke("upload:resume", item.id, {
                        force: status === "error",
                      }),
                    status === "error" ? "재시도를 시작했습니다" : undefined,
                  )
                }
              >
                <PlayIcon className="size-3.5" />
                {status === "error" ? "재시도" : "시작"}
              </Button>
            ) : null}
            {item.shareLink && (
              <Button
                variant="outline"
                size="sm"
                isLoading={pendingAction === "copy"}
                onClick={() =>
                  runAction("copy", async () => onCopyLink(item), "링크를 복사했습니다")
                }
              >
                <CopyIcon className="size-3.5" />
                링크 복사
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              isLoading={removing}
              disabled={removing}
              onClick={() => onRemove(item)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                status === "completed"
                  ? "bg-emerald-500"
                  : status === "error"
                    ? "bg-destructive"
                    : "bg-primary",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <span>
                {completedCount} / {fileCount} 파일
              </span>
              {elapsedLabel && (
                <span className="flex items-center gap-0.5 tabular-nums">
                  <TimerIcon className="size-2.5" />
                  {status === "completed" ? "소요" : "경과"} {elapsedLabel}
                </span>
              )}
            </span>
            <span className="flex items-center gap-2 tabular-nums">
              {speedLabel && <span className="text-primary">{speedLabel}</span>}
              <span>
                {formatSize(uploadedBytes)} / {formatSize(totalBytes)}
              </span>
            </span>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2">
          <UploadFileList progress={progress} />
        </div>
      </ScrollArea>

      {item.description && (
        <div className="border-t p-3">
          <div className="text-xs text-muted-foreground">
            <FolderIcon className="size-3 inline mr-1" />
            {item.description}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadFileList({ progress }: { progress: UploadItem["progress"] }) {
  const entries = Object.values(progress).sort((a, b) => a.path.localeCompare(b.path));

  if (entries.length === 0) {
    return <div className="py-8 text-center text-xs text-muted-foreground">파일이 없습니다</div>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {entries.map((file) => {
        const pct = file.size > 0 ? Math.min(100, (file.uploaded / file.size) * 100) : 100;
        return (
          <div
            key={file.fileId}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/40"
          >
            <span className="min-w-0 flex-1 truncate" title={file.path}>
              {file.path}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatSize(file.uploaded)} / {formatSize(file.size)}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                file.status === "completed"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : file.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : file.status === "uploading"
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground",
              )}
            >
              {file.status === "completed"
                ? "완료"
                : file.status === "error"
                  ? "오류"
                  : file.status === "uploading"
                    ? `${pct.toFixed(0)}%`
                    : file.status === "paused"
                      ? "일시정지"
                      : "대기"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
