import type { DownloadItem } from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import { formatSize, formatSpeed, formatTime } from "@shared/utils";
import { ClockIcon, FolderIcon, LockIcon, TimerIcon } from "lucide-react";

export function DownloadCard({
  item,
  active,
  onClick,
}: {
  item: DownloadItem;
  active: boolean;
  onClick: () => void;
}) {
  const { collection, status, summary } = item;
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

  const expiresLabel = new Date(collection.expires * 1000).toLocaleDateString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

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
      {/* title + status pin */}
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            <span
              className="cn-font-heading min-w-0 flex-1 truncate text-sm font-medium"
              title={collection.name}
            >
              {collection.name}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {collection.shareId}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* progress bar */}
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
            <span>{formatSize(downloadedBytes)}</span>
          </span>
        </div>
      </div>

      {/* meta */}
      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-0.5">
          <ClockIcon className="size-2.5" />
          {expiresLabel}
        </span>
        {collection.passwordProtected && (
          <span className="flex items-center gap-0.5">
            <LockIcon className="size-2.5" />
            비밀번호
          </span>
        )}
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: DownloadItem["status"] }) {
  const map: Record<DownloadItem["status"], { label: string; cls: string }> = {
    downloading: { label: "다운로드", cls: "bg-primary/10 text-primary" },
    paused: { label: "일시정지", cls: "bg-muted text-muted-foreground" },
    completed: { label: "완료", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
    queued: { label: "대기", cls: "bg-muted text-muted-foreground" },
    error: { label: "오류", cls: "bg-destructive/10 text-destructive" },
    expired: { label: "만료", cls: "bg-muted text-muted-foreground" },
  };
  const s = map[status];
  return (
    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", s.cls)}>
      {s.label}
    </span>
  );
}
