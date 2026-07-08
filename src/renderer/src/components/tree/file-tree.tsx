import { Checkbox } from "@renderer/components/ui/checkbox";
import type {
  DirNode,
  DownloadStatus,
  FileNode,
  FileProgress,
  TreeEntry,
} from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import { useDownloadTreeExpanded } from "@renderer/stores/download-tree-expanded";
import { formatSize, formatSpeed } from "@shared/utils";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import * as React from "react";

export interface FileTreeSelectionProps {
  mode: "selection";
  root: DirNode;
  selected: Set<string>;
  onToggle: (key: string) => void;
}

export interface FileTreeProgressProps {
  mode: "progress";
  downloadId: string;
  root: DirNode;
  progress: Record<string, FileProgress>;
  collectionStatus?: DownloadStatus;
  onPauseFile?: (fileId: string) => void;
  onResumeFile?: (fileId: string, force: boolean) => void;
  onIncludeFile?: (fileId: string) => void;
  onIncludeFolder?: (folderPath: string) => void;
}

export type FileTreeProps = FileTreeSelectionProps | FileTreeProgressProps;

export const FILE_TREE_RIGHT_COLS: Record<FileTreeProps["mode"], string[]> = {
  // [크기]
  selection: ["4rem"],
  // [속도, 진행률, 상태, 액션]
  progress: ["5.5rem", "10rem", "5rem", "2.5rem"],
};

export function fileTreeGridTemplateColumns(rightCols: readonly string[]) {
  return `auto minmax(0, 1fr) ${rightCols.join(" ")}`;
}

export function FileTreeLeadColumn({ withCheckbox = false }: { withCheckbox?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className="size-4 shrink-0" />
      {withCheckbox && <span className="size-4 shrink-0" />}
      <span className="size-4 shrink-0" />
    </span>
  );
}

export function FileTree(props: FileTreeProps) {
  return (
    <div className="select-none text-sm">
      <TreeNode
        entry={{ kind: "dir", node: props.root }}
        depth={0}
        pathStack={[]}
        rootKey=""
        props={props}
      />
    </div>
  );
}

interface TreeNodeProps {
  entry: TreeEntry;
  depth: number;
  pathStack: string[];
  rootKey: string;
  props: FileTreeProps;
}

function TreeNode({ entry, depth, pathStack, rootKey, props }: TreeNodeProps) {
  const indent = depth * 16 + 8;
  const rightCols = FILE_TREE_RIGHT_COLS[props.mode];

  if (entry.kind === "file") {
    return (
      <FileRow
        node={entry.node as FileNode}
        indent={indent}
        pathStack={pathStack}
        rootKey={rootKey}
        props={props}
        rightCols={rightCols}
      />
    );
  }
  return (
    <DirRow
      node={entry.node as DirNode}
      depth={depth}
      indent={indent}
      pathStack={pathStack}
      rootKey={rootKey}
      props={props}
      rightCols={rightCols}
    />
  );
}

function FileRow({
  node,
  indent,
  pathStack,
  rootKey: _rootKey,
  props,
  rightCols,
}: {
  node: FileNode;
  indent: number;
  pathStack: string[];
  rootKey: string;
  props: FileTreeProps;
  rightCols: string[];
}) {
  const selectionKey = [...pathStack, node.name].join("/");

  if (props.mode === "selection") {
    return (
      <TreeRow
        indent={indent}
        checked={props.selected.has(selectionKey)}
        onToggle={() => props.onToggle(selectionKey)}
        icon={<FileIcon className="size-4 text-muted-foreground" />}
        label={node.name}
        rightCols={rightCols}
        right={[
          <span key="size" className="text-right text-xs text-muted-foreground">
            {formatSize(node.size)}
          </span>,
        ]}
      />
    );
  }

  const prog = props.progress[selectionKey];
  const status = prog?.status ?? "pending";
  const downloaded = prog?.downloaded ?? 0;
  const pct = node.size > 0 ? Math.min(100, (downloaded / node.size) * 100) : 0;
  const selected = prog?.selected ?? true;
  const speedLabel = selected && status === "downloading" ? formatSpeed(prog?.speedBps) : null;

  return (
    <TreeRow
      indent={indent}
      icon={<FileIcon className="size-4 text-muted-foreground" />}
      label={node.name}
      rightCols={rightCols}
      right={[
        <span
          key="speed"
          className={cn(
            "text-right text-xs tabular-nums",
            speedLabel ? "text-primary" : "invisible",
          )}
        >
          {speedLabel ?? "0 B/s"}
        </span>,
        selected ? (
          <span
            key="progress"
            className="whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground"
          >
            {formatSize(downloaded)} / {formatSize(node.size)}
          </span>
        ) : null,
        <div key="status" className="flex justify-end">
          <StatusPill status={selected ? status : "skipped"} pct={pct} />
        </div>,
        <div key="action" className="flex items-center justify-end">
          {selected && prog && status === "downloading" && props.onPauseFile && (
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => props.onPauseFile?.(prog.fileId)}
              title="일시정지"
            >
              <PauseIcon className="size-3" />
            </button>
          )}
          {selected &&
            prog &&
            (status === "paused" || status === "pending" || status === "error") &&
            props.collectionStatus !== "expired" &&
            props.onResumeFile && (
              <button
                type="button"
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => props.onResumeFile?.(prog.fileId, status === "error")}
                title="시작"
              >
                <PlayIcon className="size-3" />
              </button>
            )}
          {!selected && prog && props.collectionStatus !== "expired" && props.onIncludeFile && (
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => props.onIncludeFile?.(prog.fileId)}
              title="다운로드에 추가"
            >
              <PlayIcon className="size-3" />
            </button>
          )}
        </div>,
      ]}
    />
  );
}

function DirRow({
  node,
  depth,
  indent,
  pathStack,
  rootKey,
  props,
  rightCols,
}: {
  node: DirNode;
  depth: number;
  indent: number;
  pathStack: string[];
  rootKey: string;
  props: FileTreeProps;
  rightCols: string[];
}) {
  const isRoot = node.name === "";
  const childPathStack = isRoot ? pathStack : [...pathStack, node.name];
  const childRootKey = isRoot ? rootKey : rootKey ? `${rootKey}/${node.name}` : node.name;

  const dirKey = isRoot ? "" : [...pathStack, node.name].join("/");
  const progressDownloadId = props.mode === "progress" ? props.downloadId : null;
  const storedExpanded = useDownloadTreeExpanded((state) =>
    progressDownloadId && dirKey
      ? (state.expandedByDownload[progressDownloadId]?.has(dirKey) ?? false)
      : false,
  );
  const toggleStoredExpanded = useDownloadTreeExpanded((state) => state.toggleExpanded);
  const [selectionExpanded, setSelectionExpanded] = React.useState(true);
  const expanded = isRoot ? true : props.mode === "progress" ? storedExpanded : selectionExpanded;

  const checked = props.mode === "selection" && dirKey !== "" ? props.selected.has(dirKey) : false;

  const total = dirSize(node);
  const dirSummary =
    props.mode === "progress" ? summarizeDirProgress(node, childPathStack, props.progress) : null;
  const showDirExcluded = dirSummary?.allExcluded ?? false;
  const showDirProgress =
    dirSummary !== null &&
    !showDirExcluded &&
    dirSummary.selectedCount > 0 &&
    (dirSummary.hasDownloading ||
      dirSummary.hasPaused ||
      dirSummary.hasError ||
      dirSummary.downloaded > 0);
  const dirSpeedLabel =
    showDirProgress && dirSummary.hasDownloading ? formatSpeed(dirSummary.speedBps) : null;
  const dirPct =
    dirSummary && dirSummary.totalSize > 0
      ? Math.min(100, (dirSummary.downloaded / dirSummary.totalSize) * 100)
      : 0;

  return (
    <>
      {!isRoot && (
        <TreeRow
          indent={indent}
          expandable
          expanded={expanded}
          onExpand={() => {
            if (props.mode === "progress" && progressDownloadId) {
              toggleStoredExpanded(progressDownloadId, dirKey);
              return;
            }
            setSelectionExpanded((value) => !value);
          }}
          checked={checked}
          onToggle={
            props.mode === "selection" && dirKey !== "" ? () => props.onToggle(dirKey) : undefined
          }
          icon={
            <FolderIcon
              className={cn("size-4 text-muted-foreground", expanded && "text-primary")}
            />
          }
          label={`${node.name}/`}
          rightCols={rightCols}
          right={
            props.mode === "progress"
              ? showDirExcluded
                ? [
                    <span key="speed" className="invisible text-right text-xs tabular-nums">
                      0 B/s
                    </span>,
                    null,
                    <div key="status" className="flex justify-end">
                      <StatusPill status="skipped" pct={0} />
                    </div>,
                    <div
                      key="action"
                      className="flex items-center justify-end"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {props.collectionStatus !== "expired" && props.onIncludeFolder && (
                        <button
                          type="button"
                          className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() => props.onIncludeFolder?.(dirKey)}
                          title="다운로드에 추가"
                        >
                          <PlayIcon className="size-3" />
                        </button>
                      )}
                    </div>,
                  ]
                : showDirProgress
                  ? [
                      <span
                        key="speed"
                        className={cn(
                          "text-right text-xs tabular-nums",
                          dirSpeedLabel ? "text-primary" : "invisible",
                        )}
                      >
                        {dirSpeedLabel ?? "0 B/s"}
                      </span>,
                      <span
                        key="progress"
                        className="whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground"
                      >
                        {formatSize(dirSummary.downloaded)} / {formatSize(dirSummary.totalSize)}
                      </span>,
                      <div key="status" className="flex justify-end">
                        <StatusPill status={dirSummary.status} pct={dirPct} />
                      </div>,
                      null,
                    ]
                  : [null, null, null, null]
              : [
                  <span
                    key="size"
                    className="text-right text-xs text-muted-foreground tabular-nums"
                  >
                    {formatSize(total)}
                  </span>,
                ]
          }
        />
      )}
      {expanded &&
        node.entries.map((e, i) => (
          <TreeNode
            key={`${e.kind}-${(e.node as { id: string }).id ?? i}`}
            entry={e}
            depth={isRoot ? depth : depth + 1}
            pathStack={childPathStack}
            rootKey={childRootKey}
            props={props}
          />
        ))}
    </>
  );
}

function dirSize(dir: DirNode): number {
  let total = 0;
  for (const e of dir.entries) {
    total += e.kind === "file" ? (e.node as FileNode).size : dirSize(e.node as DirNode);
  }
  return total;
}

function summarizeDirProgress(
  dir: DirNode,
  pathStack: string[],
  progress: Record<string, FileProgress>,
) {
  let totalSize = 0;
  let downloaded = 0;
  let speedBps = 0;
  let fileCount = 0;
  let excludedCount = 0;
  let selectedCount = 0;
  let folderTotalSize = 0;
  let completedCount = 0;
  let hasDownloading = false;
  let hasPaused = false;
  let hasError = false;

  function walk(node: DirNode, stack: string[]) {
    for (const e of node.entries) {
      if (e.kind === "file") {
        const file = e.node as FileNode;
        const key = [...stack, file.name].join("/");
        const prog = progress[key];
        const selected = prog?.selected ?? true;

        fileCount += 1;
        folderTotalSize += file.size;

        if (!selected) {
          excludedCount += 1;
          continue;
        }

        selectedCount += 1;
        totalSize += file.size;
        downloaded += prog?.downloaded ?? 0;

        const status = prog?.status ?? "pending";
        if (status === "downloading") {
          hasDownloading = true;
          speedBps += prog?.speedBps ?? 0;
        } else if (status === "paused") {
          hasPaused = true;
        } else if (status === "error") {
          hasError = true;
        } else if (status === "completed") {
          completedCount += 1;
        }
        continue;
      }

      const child = e.node as DirNode;
      walk(child, child.name === "" ? stack : [...stack, child.name]);
    }
  }

  walk(dir, pathStack);

  const allExcluded = fileCount > 0 && excludedCount === fileCount;
  const status = allExcluded
    ? "skipped"
    : selectedCount > 0 && completedCount === selectedCount
      ? "completed"
      : hasDownloading
        ? "downloading"
        : hasError
          ? "error"
          : hasPaused
            ? "paused"
            : "pending";

  return {
    totalSize,
    folderTotalSize,
    downloaded,
    speedBps,
    fileCount,
    excludedCount,
    selectedCount,
    allExcluded,
    hasDownloading,
    hasPaused,
    hasError,
    status,
  };
}

interface TreeRowProps {
  indent: number;
  expandable?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  checked?: boolean;
  onToggle?: () => void;
  icon: React.ReactNode;
  label: string;
  right?: React.ReactNode[];
  rightCols: string[];
}

function TreeRow({
  indent,
  expandable,
  expanded,
  onExpand,
  checked,
  onToggle,
  icon,
  label,
  right,
  rightCols,
}: TreeRowProps) {
  return (
    <div
      className={cn(
        "grid h-7 items-center gap-x-1 rounded-md pr-2 hover:bg-muted/50",
        "data-[hovered]:bg-muted",
        expandable && "cursor-pointer",
      )}
      style={{
        paddingLeft: indent,
        gridTemplateColumns: fileTreeGridTemplateColumns(rightCols),
      }}
      onClick={expandable ? onExpand : undefined}
    >
      {/* 확장 토글 · 체크박스 · 아이콘 */}
      <div className="flex items-center gap-1">
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center text-muted-foreground",
            !expandable && "opacity-0",
          )}
        >
          {expandable && expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </span>

        {onToggle && (
          <div onClick={(e) => e.stopPropagation()}>
            <Checkbox checked={checked ?? false} onCheckedChange={onToggle} className="shrink-0" />
          </div>
        )}

        {icon}
      </div>

      {/* 라벨 */}
      <span className="truncate">{label}</span>

      {/* 우측 영역 — 각 컬럼이 고정 너비를 가져 라벨 영역 밀림 방지 */}
      {right &&
        right.map((cell, i) => (
          <div
            key={i}
            className="flex items-center justify-end gap-2 overflow-hidden whitespace-nowrap"
          >
            {cell}
          </div>
        ))}
    </div>
  );
}

function StatusPill({ status, pct }: { status: string; pct: number }) {
  const label =
    status === "completed"
      ? "완료"
      : status === "downloading"
        ? `${pct.toFixed(0)}%`
        : status === "paused"
          ? "일시정지"
          : status === "error"
            ? "오류"
            : status === "skipped"
              ? "제외"
              : "대기";
  const cls =
    status === "completed"
      ? "text-emerald-600 dark:text-emerald-400"
      : status === "downloading"
        ? "text-primary"
        : status === "error"
          ? "text-destructive"
          : "text-muted-foreground";
  return (
    <span
      className={cn("inline-block w-12 shrink-0 text-right text-xs font-medium tabular-nums", cls)}
    >
      {label}
    </span>
  );
}
