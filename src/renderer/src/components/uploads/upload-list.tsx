import { FileTree, type FileTreeError } from "@renderer/components/tree/file-tree";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useRemoveTransfer } from "@renderer/hooks/use-remove-transfer";
import { cn } from "@renderer/lib/utils";
import type { DownloadStatus, FileProgress, UploadFileProgress, UploadItem } from "@shared/types";
import { formatSize, formatSpeed, formatTime } from "@shared/utils";
import {
  BrushCleaningIcon,
  ClockIcon,
  CopyIcon,
  FilterIcon,
  FolderIcon,
  LinkIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  TimerIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { UploadCard } from "./upload-card";

type UploadFilter = "all" | "active" | "completed";

const removeUploadOptions = {
  removeById: (id: string) => window.api.invoke("upload:remove", id),
  errorMessage: "삭제하지 못했습니다",
  dialogTitle: "업로드 삭제",
  dialogDescription: "아직 완료되지 않은 업로드입니다. 정말 삭제하시겠습니까?",
};

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
  const [errorDetails, setErrorDetails] = React.useState<FileTreeError[] | null>(null);
  const [replacementTarget, setReplacementTarget] = React.useState<UploadItem | null>(null);
  const [resolvingReplacement, setResolvingReplacement] = React.useState(false);

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
    if (!selectedId || !filtered.some((i) => i.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? null);
    }
  }, [filtered, selectedId]);

  React.useEffect(() => {
    if (replacementTarget) return;
    const target = items.find((item) => item.mode === "integrated" && item.requiresReplacement);
    if (target) {
      setSelectedId(target.id);
      setReplacementTarget(target);
    }
  }, [items, replacementTarget]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const { remove, removeCompleted, dialog, removing } =
    useRemoveTransfer<UploadItem>(removeUploadOptions);
  const hasCompleted = items.some((item) => item.status === "completed");

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

  const handleShareInfo = async (item: UploadItem) => {
    if (!item.shareLink && !item.shareValue) {
      toast.error("아직 공유 정보가 생성되지 않았습니다");
      return;
    }
    try {
      if (item.shareValue) {
        const result = await window.api.invoke("upload:saveShareInfo", item.id);
        if (result) toast.success("공유 정보를 저장했습니다");
        return;
      }
      await window.api.invoke("upload:copyLink", item.id);
      toast.success("링크를 복사했습니다");
    } catch (error) {
      toast.error(item.shareValue ? "저장하지 못했습니다" : "복사하지 못했습니다", {
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
                      onShowError={() => setErrorDetails(getUploadErrors(item))}
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
                    {(item.shareLink || item.shareValue) && (
                      <ContextMenuItem onClick={() => handleShareInfo(item)}>
                        {item.shareValue ? <SaveIcon /> : <CopyIcon />}
                        {item.shareValue ? "공유 정보 저장" : "링크 복사"}
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
        <UploadDetail
          item={selected}
          onRemove={remove}
          removing={removing}
          onShareInfo={handleShareInfo}
          onNewUpload={onNewUpload}
          onError={setErrorDetails}
        />
      </div>
      {dialog}
      <UploadErrorDialog
        errors={errorDetails}
        onOpenChange={(open) => {
          if (!open) setErrorDetails(null);
        }}
      />
      <AlertDialog open={replacementTarget !== null} onOpenChange={() => undefined}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>물리 컬렉션 업로드 실패</AlertDialogTitle>
            <AlertDialogDescription>
              통합 공유에는 모든 데이터가 필요합니다. 새 컬렉션을 만들려면 Turnstile 인증 후 실패한
              분량을 처음부터 다시 업로드합니다. 전체 취소 시 이미 생성된 원격 컬렉션은 만료일까지
              남습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              variant="destructive"
              disabled={resolvingReplacement}
              onClick={() => {
                if (!replacementTarget) return;
                setResolvingReplacement(true);
                void window.api
                  .invoke("upload:remove", replacementTarget.id)
                  .then(() => setReplacementTarget(null))
                  .catch((error) =>
                    toast.error("전송을 취소하지 못했습니다", {
                      description: error instanceof Error ? error.message : String(error),
                    }),
                  )
                  .finally(() => setResolvingReplacement(false));
              }}
            >
              전체 전송 취소
            </AlertDialogAction>
            <AlertDialogAction
              disabled={resolvingReplacement}
              isLoading={resolvingReplacement}
              onClick={() => {
                if (!replacementTarget) return;
                setResolvingReplacement(true);
                void window.api
                  .invoke("upload:replaceFailedCollection", replacementTarget.id)
                  .then(() => setReplacementTarget(null))
                  .catch((error) =>
                    toast.error("새 컬렉션을 만들지 못했습니다", {
                      description: error instanceof Error ? error.message : String(error),
                    }),
                  )
                  .finally(() => setResolvingReplacement(false));
              }}
            >
              새 컬렉션을 만들어 다시 시도
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function UploadDetail({
  item,
  onRemove,
  removing,
  onShareInfo,
  onNewUpload,
  onError,
}: {
  item: UploadItem | null;
  onRemove: (item: UploadItem) => void;
  removing: boolean;
  onShareInfo: (item: UploadItem) => void;
  onNewUpload: () => void;
  onError: (errors: FileTreeError[]) => void;
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

  const { progress, status, summary } = item;
  const totalBytes = summary.totalBytes;
  const uploadedBytes = summary.transferredBytes;
  const pct = totalBytes > 0 ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 0;
  const fileCount = summary.totalFiles;
  const completedCount = summary.completedFiles;
  const speedLabel = status === "uploading" ? formatSpeed(item.speedBps) : null;
  const elapsedLabel =
    item.elapsedMs != null && item.elapsedMs > 0
      ? formatTime(item.elapsedMs / 1000, navigator.language)
      : null;

  const expiresLabel = new Date(item.expires).toLocaleString("ko-KR", {
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
                  <button
                    type="button"
                    className="truncate text-primary underline underline-offset-2 hover:opacity-80"
                    onClick={() =>
                      runAction("open", () =>
                        window.api.invoke("util:openExternal", item.shareLink!),
                      )
                    }
                  >
                    {item.shareLink}
                  </button>
                </span>
              ) : item.shareValue ? (
                <span className="flex items-center gap-1 font-mono text-primary">
                  <LinkIcon className="size-3" />
                  {item.shareKind === "extended"
                    ? "Kiosk Downloader 확장 공유 정보"
                    : "호환 링크 목록"}
                </span>
              ) : (
                <span className="text-muted-foreground/60">공유 정보 생성 대기 중</span>
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
            {(item.shareLink || item.shareValue) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => runAction("share", async () => onShareInfo(item))}
              >
                {item.shareValue ? (
                  <SaveIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {item.shareValue ? "공유 정보 저장" : "링크 복사"}
              </Button>
            )}
            {item.shareKind === "extended" && item.passwordProtected && item.shareValue && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  runAction(
                    "copy-password",
                    () => window.api.invoke("upload:copyPassword", item.id),
                    "비밀번호를 복사했습니다",
                  )
                }
              >
                <LockIcon className="size-3.5" />
                비밀번호 복사
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

        {status === "expired" && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-muted-foreground/20 bg-muted/50 px-3 py-2 text-xs">
            <div>
              <p className="font-medium">업로드 세션이 만료되었습니다</p>
              <p className="mt-0.5 text-muted-foreground">
                기존 파일을 재사용하지 않습니다. 새 업로드에서 파일을 다시 선택하세요.
              </p>
            </div>
            <Button size="xs" variant="outline" onClick={onNewUpload}>
              새 업로드 만들기
            </Button>
          </div>
        )}

        {status === "error" && item.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {item.error}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2">
          <UploadFileList
            uploadId={item.id}
            tree={item.tree}
            collectionStatus={status}
            pendingAction={pendingAction}
            progress={progress}
            onPauseFile={(fileId) =>
              runAction("file", () => window.api.invoke("upload:pauseFile", item.id, fileId))
            }
            onResumeFile={(fileId, force) =>
              runAction("file", () =>
                window.api.invoke("upload:resumeFile", item.id, fileId, { force }),
              )
            }
            onError={onError}
          />
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

function UploadFileList({
  uploadId,
  tree,
  collectionStatus,
  pendingAction,
  progress,
  onPauseFile,
  onResumeFile,
  onError,
}: {
  uploadId: string;
  tree: UploadItem["tree"];
  collectionStatus: UploadItem["status"];
  pendingAction: string | null;
  progress: UploadItem["progress"];
  onPauseFile: (fileId: string) => void;
  onResumeFile: (fileId: string, force: boolean) => void;
  onError: (errors: FileTreeError[]) => void;
}) {
  if (Object.keys(progress).length === 0) {
    return <div className="py-8 text-center text-xs text-muted-foreground">파일이 없습니다</div>;
  }

  return (
    <>
      <FileTree
        mode="progress"
        downloadId={`upload:${uploadId}`}
        root={tree}
        progress={toTreeProgress(progress)}
        collectionStatus={toDownloadStatus(collectionStatus)}
        onPauseFile={pendingAction === "file" ? undefined : onPauseFile}
        onResumeFile={pendingAction === "file" ? undefined : onResumeFile}
        onError={onError}
      />
    </>
  );
}

function getUploadErrors(item: UploadItem): FileTreeError[] {
  const errors: FileTreeError[] = item.error ? [{ path: "업로드", message: item.error }] : [];

  for (const file of Object.values(item.progress)) {
    if (file.status === "error") {
      errors.push({ path: file.path, message: file.error ?? "오류 정보가 없습니다." });
    }
  }

  return errors;
}

function UploadErrorDialog({
  errors,
  onOpenChange,
}: {
  errors: FileTreeError[] | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={errors !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>업로드 오류 상세</DialogTitle>
          <DialogDescription>{errors?.length ?? 0}개 오류가 발생했습니다.</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-3 overflow-y-auto rounded-md border bg-muted/30 p-3">
          {errors?.map((error) => (
            <div key={`${error.path}:${error.message}`} className="space-y-1 text-xs">
              <p className="font-medium break-all">{error.path}</p>
              <pre className="text-destructive whitespace-pre-wrap break-words font-mono">
                {error.message}
              </pre>
            </div>
          ))}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

function toTreeProgress(progress: UploadItem["progress"]): Record<string, FileProgress> {
  return Object.fromEntries(
    Object.entries(progress).map(([path, file]) => [path, toTreeFileProgress(file)]),
  );
}

function toTreeFileProgress(file: UploadFileProgress): FileProgress {
  const cached = treeProgressCache.get(file);
  if (cached) return cached;

  const converted: FileProgress = {
    fileId: file.fileId,
    path: file.path,
    status: file.status === "uploading" ? "downloading" : file.status,
    downloaded: file.uploaded,
    size: file.size,
    selected: true,
    speedBps: file.speedBps,
    error: file.error,
  };
  treeProgressCache.set(file, converted);
  return converted;
}

const treeProgressCache = new WeakMap<UploadFileProgress, FileProgress>();

function toDownloadStatus(status: UploadItem["status"]): DownloadStatus {
  return status === "uploading" ? "downloading" : status;
}
