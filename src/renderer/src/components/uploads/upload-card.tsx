import { cn } from "@renderer/lib/utils";
import type { UploadItem, UploadStatus } from "@shared/types";
import { formatSize, formatSpeed, formatTime } from "@shared/utils";
import { ClockIcon, CopyIcon, FolderIcon, LockIcon, SaveIcon, TimerIcon } from "lucide-react";
import { toast } from "sonner";

export function UploadCard({
  item,
  active,
  onClick,
  onShowError,
}: {
  item: UploadItem;
  active: boolean;
  onClick: () => void;
  onShowError?: () => void;
}) {
  const { status, summary } = item;
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

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full overflow-hidden rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
          : "border-border hover:bg-muted/50",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            <span
              className="cn-font-heading min-w-0 flex-1 truncate text-sm font-medium"
              title={item.name}
            >
              {item.name}
            </span>
          </div>
          {(item.shareLink || item.shareValue) && (
            <div className="mt-0.5 flex items-center gap-0.5 truncate font-mono text-[10px]">
              {item.shareValue ? (
                <SaveIcon className="size-2.5 shrink-0 text-muted-foreground" />
              ) : (
                <CopyIcon className="size-2.5 shrink-0 text-muted-foreground" />
              )}
              <span
                role="button"
                title={item.shareValue ? "공유 정보 저장" : "링크 복사"}
                className="cursor-pointer truncate text-primary underline underline-offset-2"
                onClick={async (e) => {
                  e.stopPropagation();
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
                }}
              >
                {item.shareValue ? "확장 공유 정보" : item.shareLink}
              </span>
            </div>
          )}
        </div>
        <UploadStatusBadge status={status} onClick={onShowError} />
      </div>

      <div className="mt-2.5 flex flex-col gap-1">
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              status === "completed"
                ? "bg-emerald-500"
                : status === "error"
                  ? "bg-destructive"
                  : status === "expired"
                    ? "bg-muted-foreground/40"
                    : "bg-primary",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="tabular-nums">
            {completedCount}/{fileCount} 파일
          </span>
          <span className="flex items-center gap-2 tabular-nums">
            {elapsedLabel && (
              <span className="flex items-center gap-0.5">
                <TimerIcon className="size-2.5" />
                {elapsedLabel}
              </span>
            )}
            {speedLabel && <span className="text-primary">{speedLabel}</span>}
            <span>{formatSize(uploadedBytes)}</span>
          </span>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        {item.mode && item.mode !== "standard" && (
          <span>{item.mode === "integrated" ? "확장 · 통합 공유" : "확장 · 호환 공유"}</span>
        )}
        <span className="flex items-center gap-0.5">
          <ClockIcon className="size-2.5" />
          {new Date(item.expires).toLocaleDateString("ko-KR", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        {item.passwordProtected && (
          <span className="flex items-center gap-0.5">
            <LockIcon className="size-2.5" />
            비밀번호
          </span>
        )}
      </div>
    </button>
  );
}

function UploadStatusBadge({ status, onClick }: { status: UploadStatus; onClick?: () => void }) {
  const map: Record<UploadStatus, { label: string; cls: string }> = {
    uploading: { label: "업로드", cls: "bg-primary/10 text-primary" },
    paused: { label: "일시정지", cls: "bg-muted text-muted-foreground" },
    completed: { label: "완료", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
    queued: { label: "대기", cls: "bg-muted text-muted-foreground" },
    error: { label: "오류", cls: "bg-destructive/10 text-destructive" },
    expired: { label: "만료", cls: "bg-muted text-muted-foreground" },
  };
  const s = map[status];
  const className = cn(
    "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
    s.cls,
    status === "error" &&
      onClick &&
      "cursor-pointer underline decoration-dotted underline-offset-2",
  );

  if (status === "error" && onClick) {
    return (
      <span
        role="button"
        tabIndex={0}
        className={className}
        title="오류 상세 보기"
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onClick();
        }}
      >
        {s.label}
      </span>
    );
  }

  return <span className={className}>{s.label}</span>;
}
