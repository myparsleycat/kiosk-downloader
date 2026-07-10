import {
  FILE_TREE_RIGHT_COLS,
  FileTree,
  FileTreeLeadColumn,
  fileTreeGridTemplateColumns,
} from "@renderer/components/tree/file-tree";
import { Button } from "@renderer/components/ui/button";
import { Progress, ProgressLabel, ProgressValue } from "@renderer/components/ui/progress";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Separator } from "@renderer/components/ui/separator";
import type { DownloadItem, SortDir, SortField } from "@renderer/lib/types";
import { sortTree } from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import { formatSize, formatSpeed, formatTime } from "@shared/utils";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ClockIcon,
  FolderOpenIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

export function DownloadDetail({
  item,
  onRemove,
  removing = false,
}: {
  item: DownloadItem | null;
  onRemove?: (item: DownloadItem) => void;
  removing?: boolean;
}) {
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [sortField, setSortField] = React.useState<SortField>("name");
  const [sortDir, setSortDir] = React.useState<SortDir>("none");
  const tree = item?.collection.tree;

  const sortedTree = React.useMemo(
    () => (tree && sortDir !== "none" ? sortTree(tree, sortField, sortDir) : tree),
    [tree, sortField, sortDir],
  );

  const handleSortClick = (field: SortField) => {
    if (field === sortField) {
      setSortDir((prev) => (prev === "none" ? "desc" : prev === "desc" ? "asc" : "none"));
      return;
    }
    setSortField(field);
    setSortDir("desc");
  };

  if (!item) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        왼쪽에서 컬렉션을 선택하세요
      </div>
    );
  }

  const { collection, progress, status, summary } = item;
  const totalBytes = summary.totalBytes;
  const downloadedBytes = summary.transferredBytes;
  const pct = totalBytes > 0 ? Math.min(100, (downloadedBytes / totalBytes) * 100) : 0;
  const fileCount = summary.totalFiles;
  const completedCount = summary.completedFiles;
  const speedLabel = status === "downloading" ? formatSpeed(item.speedBps) : null;
  const elapsedLabel =
    item.elapsedMs != null && item.elapsedMs > 0
      ? formatTime(item.elapsedMs / 1000, navigator.language)
      : null;

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

  const expiresLabel = new Date(collection.expires * 1000).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex flex-col gap-3 border-b p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="cn-font-heading truncate text-base font-medium">{collection.name}</h2>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{collection.shareId}</span>
              <Separator orientation="vertical" className="h-3" />
              <span className="flex items-center gap-1">
                <ClockIcon className="size-3" />
                만료 {expiresLabel}
              </span>
              {collection.passwordProtected && (
                <>
                  <Separator orientation="vertical" className="h-3" />
                  <span className="flex items-center gap-1">
                    <LockIcon className="size-3" />
                    비밀번호
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {status === "downloading" || status === "inflating" ? (
              <Button
                variant="outline"
                size="sm"
                isLoading={pendingAction === "pause"}
                onClick={() =>
                  runAction("pause", () => window.api.invoke("download:pauseCollection", item.id))
                }
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
                      window.api.invoke("download:resumeCollection", item.id, {
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
            <Button
              variant="outline"
              size="sm"
              isLoading={pendingAction === "folder"}
              onClick={() =>
                runAction("folder", () => window.api.invoke("download:openFolder", item.id))
              }
            >
              <FolderOpenIcon className="size-3.5" />
              폴더
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              isLoading={removing}
              disabled={removing || !onRemove}
              onClick={() => onRemove?.(item)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* total progress */}
        <div className="flex flex-col gap-1">
          <Progress value={pct}>
            <ProgressLabel>{statusLabel(status)}</ProgressLabel>
            <ProgressValue>{() => `${pct.toFixed(1)}%`}</ProgressValue>
          </Progress>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <span>
                {completedCount} / {fileCount} 파일
              </span>
              {elapsedLabel && (
                <span className="tabular-nums">
                  {status === "completed" ? "소요" : "경과"} {elapsedLabel}
                </span>
              )}
            </span>
            <span className="flex items-center gap-2 tabular-nums">
              {speedLabel && <span className="text-primary">{speedLabel}</span>}
              <span>
                {formatSize(downloadedBytes)} / {formatSize(totalBytes)}
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* file tree */}
      <ProgressSortHeader field={sortField} dir={sortDir} onSort={handleSortClick} />
      <ScrollArea className="flex-1">
        <div className="p-2">
          <FileTree
            mode="progress"
            downloadId={item.id}
            root={sortedTree ?? collection.tree}
            progress={progress}
            collectionStatus={status}
            onPauseFile={(fileId) =>
              runAction("file", () => window.api.invoke("download:pauseFile", item.id, fileId))
            }
            onResumeFile={(fileId, force) =>
              runAction("file", () =>
                window.api.invoke("download:resumeFile", item.id, fileId, { force }),
              )
            }
            onIncludeFile={(fileId) =>
              runAction(
                "file",
                () => window.api.invoke("download:includeFile", item.id, fileId),
                "다운로드 큐에 추가했습니다",
              )
            }
            onIncludeFolder={(folderPath) =>
              runAction(
                "folder",
                () => window.api.invoke("download:includeFolder", item.id, folderPath),
                "다운로드 큐에 추가했습니다",
              )
            }
          />
        </div>
      </ScrollArea>

      {/* save path */}
      <div className="border-t p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FolderOpenIcon className="size-3.5" />
          <span className={cn("truncate font-mono")}>{item.savePath}</span>
        </div>
      </div>
    </div>
  );
}

function statusLabel(status: DownloadItem["status"]): string {
  switch (status) {
    case "downloading":
      return "다운로드 중";
    case "inflating":
      return "해제 중";
    case "paused":
      return "일시정지";
    case "completed":
      return "완료";
    case "queued":
      return "대기 중";
    case "error":
      return "오류";
    case "expired":
      return "만료";
    default:
      return status;
  }
}

function ProgressSortHeader({
  field,
  dir,
  onSort,
}: {
  field: SortField;
  dir: SortDir;
  onSort: (field: SortField) => void;
}) {
  return (
    <div
      className="grid items-center gap-x-1 border-b px-2 py-1 text-xs text-muted-foreground"
      style={{ gridTemplateColumns: fileTreeGridTemplateColumns(FILE_TREE_RIGHT_COLS.progress) }}
    >
      <FileTreeLeadColumn />
      <SortButton
        label="이름"
        active={dir !== "none" && field === "name"}
        dir={field === "name" ? dir : "none"}
        onClick={() => onSort("name")}
      />
      <span className="text-right text-muted-foreground/60">속도</span>
      <span className="text-right text-muted-foreground/60">진행</span>
      <span className="text-right text-muted-foreground/60">상태</span>
      <span className="text-right text-muted-foreground/60"> </span>
    </div>
  );
}

function SortButton({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex shrink-0 items-center gap-1 rounded px-1 py-0.5 font-medium transition-colors hover:bg-muted hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
      )}
      onClick={onClick}
    >
      <span>{label}</span>
      {dir === "asc" ? (
        <ArrowUpIcon className="size-3" />
      ) : dir === "desc" ? (
        <ArrowDownIcon className="size-3" />
      ) : (
        <ArrowUpDownIcon className={cn("size-3", active ? "opacity-100" : "opacity-40")} />
      )}
    </button>
  );
}
