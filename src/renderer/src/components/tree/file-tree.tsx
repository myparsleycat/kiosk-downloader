import { Checkbox } from "@renderer/components/ui/checkbox";
import type {
  DirNode,
  DownloadStatus,
  FileNode,
  FileProgress,
  TreeEntry,
  ZipNode,
} from "@renderer/lib/types";
import { getSelectionCheckState, dirTotalSize } from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import { useDownloadTreeExpanded } from "@renderer/stores/download-tree-expanded";
import { formatSize, formatSpeed } from "@shared/utils";
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  Loader2Icon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";

export interface FileTreeSelectionProps {
  mode: "selection";
  root: DirNode;
  selected?: Set<string>;
  onToggle?: (key: string) => void;
  onDelete?: (key: string) => void;
  onRename?: (oldPath: string, newName: string) => void;
  renames?: Record<string, string>;
  onExpandZip?: (key: string, zipId: string) => void | Promise<void>;
  zipLoadingPaths?: Set<string>;
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
  onError?: (errors: FileTreeError[]) => void;
}

export interface FileTreeError {
  path: string;
  message: string;
}

export type FileTreeProps = FileTreeSelectionProps | FileTreeProgressProps;

export const FILE_TREE_RIGHT_COLS: Record<FileTreeProps["mode"], string[]> = {
  selection: ["4rem", "1.5rem"],
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
  const progress = props.mode === "progress" ? props.progress : null;
  const dirSummaries = React.useMemo(
    () => (progress ? buildDirProgressSummaries(props.root, progress) : null),
    [props.root, progress],
  );

  return (
    <div className="select-none text-sm">
      <TreeNode
        entry={{ kind: "dir", node: props.root }}
        depth={0}
        pathStack={[]}
        rootKey=""
        props={props}
        dirSummaries={dirSummaries}
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
  dirSummaries: Map<string, DirProgressSummary> | null;
}

function TreeNode({ entry, depth, pathStack, rootKey, props, dirSummaries }: TreeNodeProps) {
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

  if (entry.kind === "zip") {
    return (
      <ZipRow
        node={entry.node as ZipNode}
        depth={depth}
        indent={indent}
        pathStack={pathStack}
        rootKey={rootKey}
        props={props}
        rightCols={rightCols}
        dirSummaries={dirSummaries}
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
      dirSummaries={dirSummaries}
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
    const renamed = props.renames?.[selectionKey];
    const label = renamed ?? node.name;
    return (
      <TreeRow
        indent={indent}
        checked={props.selected?.has(selectionKey)}
        onToggle={props.onToggle ? () => props.onToggle?.(selectionKey) : undefined}
        icon={<FileIcon className="size-4 text-muted-foreground" />}
        label={label}
        rightCols={rightCols}
        selectionKey={selectionKey}
        editable={Boolean(props.onRename)}
        onRename={props.onRename ? (newName) => props.onRename?.(selectionKey, newName) : undefined}
        right={[
          <span key="size" className="text-right text-xs text-muted-foreground">
            {formatSize(node.size)}
          </span>,
          props.onDelete ? (
            <div key="delete" className="flex items-center justify-end">
              <button
                type="button"
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDelete?.(selectionKey);
                }}
                title="삭제"
              >
                <Trash2Icon className="size-3" />
              </button>
            </div>
          ) : null,
        ]}
      />
    );
  }

  return (
    <ProgressFileRow
      node={node}
      indent={indent}
      selectionKey={selectionKey}
      progress={props.progress[selectionKey]}
      collectionStatus={props.collectionStatus}
      onPauseFile={props.onPauseFile}
      onResumeFile={props.onResumeFile}
      onIncludeFile={props.onIncludeFile}
      onError={props.onError}
      rightCols={rightCols}
    />
  );
}

interface ProgressFileRowProps {
  node: FileNode;
  indent: number;
  selectionKey: string;
  progress?: FileProgress;
  collectionStatus?: DownloadStatus;
  onPauseFile?: (fileId: string) => void;
  onResumeFile?: (fileId: string, force: boolean) => void;
  onIncludeFile?: (fileId: string) => void;
  onError?: (errors: FileTreeError[]) => void;
  rightCols: string[];
}

const ProgressFileRow = React.memo(function ProgressFileRow({
  node,
  indent,
  selectionKey,
  progress: prog,
  collectionStatus,
  onPauseFile,
  onResumeFile,
  onIncludeFile,
  onError,
  rightCols,
}: ProgressFileRowProps) {
  const status = prog?.status ?? "pending";
  const downloaded = prog?.downloaded ?? 0;
  const pct = node.size > 0 ? Math.min(100, (downloaded / node.size) * 100) : 0;
  const selected = prog?.selected ?? true;
  const speedLabel = selected && status === "downloading" ? formatSpeed(prog?.speedBps) : null;
  const errors =
    status === "error"
      ? [{ path: selectionKey, message: prog?.error ?? "오류 정보가 없습니다." }]
      : [];

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
          <StatusPill
            status={
              selected ? (prog?.completedElsewhere ? "completed_elsewhere" : status) : "skipped"
            }
            pct={pct}
            onClick={errors.length > 0 ? () => onError?.(errors) : undefined}
          />
        </div>,
        <div key="action" className="flex items-center justify-end">
          {selected &&
            prog &&
            (status === "downloading" || status === "inflating") &&
            onPauseFile && (
              <button
                type="button"
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onPauseFile(prog.fileId)}
                title="일시정지"
              >
                <PauseIcon className="size-3" />
              </button>
            )}
          {selected &&
            prog &&
            (status === "paused" || status === "pending" || status === "error") &&
            collectionStatus !== "expired" &&
            onResumeFile && (
              <button
                type="button"
                className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onResumeFile(prog.fileId, status === "error")}
                title="시작"
              >
                <PlayIcon className="size-3" />
              </button>
            )}
          {!selected && prog && collectionStatus !== "expired" && onIncludeFile && (
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => onIncludeFile(prog.fileId)}
              title="다운로드에 추가"
            >
              <PlayIcon className="size-3" />
            </button>
          )}
        </div>,
      ]}
    />
  );
}, areProgressFileRowPropsEqual);

function areProgressFileRowPropsEqual(previous: ProgressFileRowProps, next: ProgressFileRowProps) {
  return (
    previous.node === next.node &&
    previous.indent === next.indent &&
    previous.selectionKey === next.selectionKey &&
    previous.progress === next.progress &&
    previous.collectionStatus === next.collectionStatus &&
    previous.rightCols === next.rightCols &&
    Boolean(previous.onPauseFile) === Boolean(next.onPauseFile) &&
    Boolean(previous.onResumeFile) === Boolean(next.onResumeFile) &&
    Boolean(previous.onIncludeFile) === Boolean(next.onIncludeFile) &&
    Boolean(previous.onError) === Boolean(next.onError)
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
  dirSummaries,
}: {
  node: DirNode;
  depth: number;
  indent: number;
  pathStack: string[];
  rootKey: string;
  props: FileTreeProps;
  rightCols: string[];
  dirSummaries: Map<string, DirProgressSummary> | null;
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
  const [selectionExpanded, setSelectionExpanded] = React.useState(false);
  const expanded = isRoot ? true : props.mode === "progress" ? storedExpanded : selectionExpanded;

  const checked =
    props.mode === "selection" && dirKey !== "" && props.selected
      ? getSelectionCheckState(props.selected, dirKey, node)
      : undefined;

  const total = props.mode === "selection" ? dirTotalSize(node) : 0;
  const dirSummary = props.mode === "progress" ? (dirSummaries?.get(dirKey) ?? null) : null;
  const showDirExcluded = dirSummary?.allExcluded ?? false;
  const showDirProgress =
    dirSummary !== null &&
    !showDirExcluded &&
    dirSummary.selectedCount > 0 &&
    (dirSummary.hasDownloading ||
      dirSummary.hasInflating ||
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
            props.mode === "selection" && dirKey !== "" && props.onToggle
              ? () => props.onToggle?.(dirKey)
              : undefined
          }
          icon={
            <FolderIcon
              className={cn("size-4 text-muted-foreground", expanded && "text-primary")}
            />
          }
          label={`${props.mode === "selection" ? (props.renames?.[dirKey] ?? node.name) : node.name}/`}
          rightCols={rightCols}
          selectionKey={dirKey}
          editable={props.mode === "selection" && Boolean(props.onRename)}
          onRename={
            props.mode === "selection" && props.onRename
              ? (newName) => props.onRename?.(dirKey, newName)
              : undefined
          }
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
                        <StatusPill
                          status={dirSummary.status}
                          pct={dirPct}
                          onClick={
                            dirSummary.errors.length > 0
                              ? () => props.onError?.(dirSummary.errors)
                              : undefined
                          }
                        />
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
                  props.onDelete ? (
                    <div key="delete" className="flex items-center justify-end">
                      <button
                        type="button"
                        className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onDelete?.(dirKey);
                        }}
                        title="삭제"
                      >
                        <Trash2Icon className="size-3" />
                      </button>
                    </div>
                  ) : null,
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
            dirSummaries={dirSummaries}
          />
        ))}
    </>
  );
}

function ZipRow({
  node,
  depth,
  indent,
  pathStack,
  rootKey,
  props,
  rightCols,
  dirSummaries,
}: {
  node: ZipNode;
  depth: number;
  indent: number;
  pathStack: string[];
  rootKey: string;
  props: FileTreeProps;
  rightCols: string[];
  dirSummaries: Map<string, DirProgressSummary> | null;
}) {
  const zipKey = [...pathStack, node.name].join("/");
  const childPathStack = [...pathStack, node.name];
  const childRootKey = rootKey ? `${rootKey}/${node.name}` : node.name;
  const progressDownloadId = props.mode === "progress" ? props.downloadId : null;
  const storedExpanded = useDownloadTreeExpanded((state) =>
    progressDownloadId
      ? (state.expandedByDownload[progressDownloadId]?.has(zipKey) ?? false)
      : false,
  );
  const toggleStoredExpanded = useDownloadTreeExpanded((state) => state.toggleExpanded);
  const [selectionExpanded, setSelectionExpanded] = React.useState(false);
  const expanded = props.mode === "progress" ? storedExpanded : selectionExpanded;
  const loading = props.mode === "selection" ? Boolean(props.zipLoadingPaths?.has(zipKey)) : false;
  const checked =
    props.mode === "selection" && props.selected
      ? getSelectionCheckState(props.selected, zipKey, node)
      : undefined;
  const dirSummary = props.mode === "progress" ? (dirSummaries?.get(zipKey) ?? null) : null;
  const hasEntries = Boolean(node.entries);

  const handleExpand = () => {
    if (props.mode === "progress" && progressDownloadId) {
      toggleStoredExpanded(progressDownloadId, zipKey);
      return;
    }
    if (!hasEntries) {
      if (props.mode === "selection") {
        void props.onExpandZip?.(zipKey, node.id);
      }
      setSelectionExpanded(true);
      return;
    }
    setSelectionExpanded((value) => !value);
  };

  return (
    <>
      <TreeRow
        indent={indent}
        expandable
        expanded={expanded && hasEntries}
        onExpand={handleExpand}
        checked={checked}
        onToggle={
          props.mode === "selection" && props.onToggle ? () => props.onToggle?.(zipKey) : undefined
        }
        icon={
          loading ? (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <ArchiveIcon
              className={cn(
                "size-4 text-muted-foreground",
                expanded && hasEntries && "text-primary",
              )}
            />
          )
        }
        label={props.mode === "selection" ? (props.renames?.[zipKey] ?? node.name) : node.name}
        rightCols={rightCols}
        selectionKey={zipKey}
        editable={props.mode === "selection" && Boolean(props.onRename)}
        onRename={
          props.mode === "selection" && props.onRename
            ? (newName) => props.onRename?.(zipKey, newName)
            : undefined
        }
        right={
          props.mode === "progress"
            ? dirSummary
              ? [
                  null,
                  <span
                    key="progress"
                    className="whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground"
                  >
                    {formatSize(dirSummary.downloaded)} / {formatSize(dirSummary.totalSize)}
                  </span>,
                  <div key="status" className="flex justify-end">
                    <StatusPill status={dirSummary.status} pct={0} />
                  </div>,
                  null,
                ]
              : [null, null, null, null]
            : [
                <span key="size" className="text-right text-xs text-muted-foreground tabular-nums">
                  {formatSize(node.size)}
                </span>,
                null,
              ]
        }
      />
      {expanded &&
        node.entries?.map((e, i) => (
          <TreeNode
            key={`${e.kind}-${(e.node as { id: string }).id ?? i}`}
            entry={e}
            depth={depth + 1}
            pathStack={childPathStack}
            rootKey={childRootKey}
            props={props.mode === "selection" ? { ...props, onRename: undefined } : props}
            dirSummaries={dirSummaries}
          />
        ))}
    </>
  );
}

interface DirProgressSummary {
  totalSize: number;
  folderTotalSize: number;
  downloaded: number;
  speedBps: number;
  fileCount: number;
  excludedCount: number;
  selectedCount: number;
  completedCount: number;
  allExcluded: boolean;
  hasDownloading: boolean;
  hasInflating: boolean;
  hasPaused: boolean;
  hasError: boolean;
  errors: FileTreeError[];
  status: "skipped" | "completed" | "downloading" | "inflating" | "error" | "paused" | "pending";
}

function buildDirProgressSummaries(root: DirNode, progress: Record<string, FileProgress>) {
  const summaries = new Map<string, DirProgressSummary>();

  function walk(dir: DirNode, pathStack: string[]): DirProgressSummary {
    let totalSize = 0;
    let downloaded = 0;
    let speedBps = 0;
    let fileCount = 0;
    let excludedCount = 0;
    let selectedCount = 0;
    let folderTotalSize = 0;
    let completedCount = 0;
    let hasDownloading = false;
    let hasInflating = false;
    let hasPaused = false;
    let hasError = false;
    const errors: FileTreeError[] = [];

    for (const e of dir.entries) {
      if (e.kind === "file") {
        const file = e.node as FileNode;
        const key = [...pathStack, file.name].join("/");
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
        } else if (status === "inflating") {
          hasInflating = true;
        } else if (status === "paused") {
          hasPaused = true;
        } else if (status === "error") {
          hasError = true;
          errors.push({ path: key, message: prog?.error ?? "오류 정보가 없습니다." });
        } else if (status === "completed") {
          completedCount += 1;
        }
        continue;
      }

      if (e.kind === "zip") {
        const zip = e.node as ZipNode;
        if (!zip.entries) {
          const key = [...pathStack, zip.name].join("/");
          const prog = progress[key];
          const selected = prog?.selected ?? true;
          fileCount += 1;
          folderTotalSize += zip.size;
          if (!selected) {
            excludedCount += 1;
            continue;
          }
          selectedCount += 1;
          totalSize += zip.size;
          downloaded += prog?.downloaded ?? 0;
          const status = prog?.status ?? "pending";
          if (status === "downloading") {
            hasDownloading = true;
            speedBps += prog?.speedBps ?? 0;
          } else if (status === "inflating") {
            hasInflating = true;
          } else if (status === "paused") {
            hasPaused = true;
          } else if (status === "error") {
            hasError = true;
            errors.push({ path: key, message: prog?.error ?? "오류 정보가 없습니다." });
          } else if (status === "completed") {
            completedCount += 1;
          }
          continue;
        }
        const childStack = [...pathStack, zip.name];
        const childSummary = walk(
          { type: "dir", id: zip.id, name: zip.name, entries: zip.entries },
          childStack,
        );
        totalSize += childSummary.totalSize;
        downloaded += childSummary.downloaded;
        speedBps += childSummary.speedBps;
        fileCount += childSummary.fileCount;
        excludedCount += childSummary.excludedCount;
        selectedCount += childSummary.selectedCount;
        folderTotalSize += childSummary.folderTotalSize;
        completedCount += childSummary.completedCount;
        hasDownloading ||= childSummary.hasDownloading;
        hasInflating ||= childSummary.hasInflating;
        hasPaused ||= childSummary.hasPaused;
        hasError ||= childSummary.hasError;
        errors.push(...childSummary.errors);
        continue;
      }

      const child = e.node as DirNode;
      const childStack = child.name === "" ? pathStack : [...pathStack, child.name];
      const childSummary = walk(child, childStack);
      totalSize += childSummary.totalSize;
      downloaded += childSummary.downloaded;
      speedBps += childSummary.speedBps;
      fileCount += childSummary.fileCount;
      excludedCount += childSummary.excludedCount;
      selectedCount += childSummary.selectedCount;
      folderTotalSize += childSummary.folderTotalSize;
      completedCount += childSummary.completedCount;
      hasDownloading ||= childSummary.hasDownloading;
      hasInflating ||= childSummary.hasInflating;
      hasPaused ||= childSummary.hasPaused;
      hasError ||= childSummary.hasError;
      errors.push(...childSummary.errors);
    }

    const allExcluded = fileCount > 0 && excludedCount === fileCount;
    const status = allExcluded
      ? "skipped"
      : selectedCount > 0 && completedCount === selectedCount
        ? "completed"
        : hasDownloading
          ? "downloading"
          : hasInflating
            ? "inflating"
            : hasError
              ? "error"
              : hasPaused
                ? "paused"
                : "pending";

    const summary: DirProgressSummary = {
      totalSize,
      folderTotalSize,
      downloaded,
      speedBps,
      fileCount,
      excludedCount,
      selectedCount,
      completedCount,
      allExcluded,
      hasDownloading,
      hasInflating,
      hasPaused,
      hasError,
      errors,
      status,
    };
    summaries.set(pathStack.join("/"), summary);
    return summary;
  }

  walk(root, []);
  return summaries;
}

interface TreeRowProps {
  indent: number;
  expandable?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  checked?: boolean | "indeterminate";
  onToggle?: () => void;
  icon: React.ReactNode;
  label: string;
  right?: React.ReactNode[];
  rightCols: string[];
  selectionKey?: string;
  onRename?: (newName: string) => void;
  editable?: boolean;
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
  selectionKey,
  onRename,
  editable,
}: TreeRowProps) {
  const isIndeterminate = checked === "indeterminate";
  const isChecked = checked === true;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(label);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const startEditing = () => {
    setDraft(label);
    setEditing(true);
  };

  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed === label || trimmed === "") return;
    onRename?.(trimmed);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(label);
  };

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  return (
    <div
      className={cn(
        "group/grid grid h-7 items-center gap-x-1 rounded-md pr-2 hover:bg-muted/50",
        "data-[hovered]:bg-muted",
        expandable && !editing && "cursor-pointer",
      )}
      style={{
        paddingLeft: indent,
        gridTemplateColumns: fileTreeGridTemplateColumns(rightCols),
      }}
      onClick={expandable && !editing ? onExpand : undefined}
    >
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
            <Checkbox
              checked={isChecked}
              indeterminate={isIndeterminate}
              onCheckedChange={onToggle}
              className="shrink-0 after:hidden"
            />
          </div>
        )}

        {icon}
      </div>

      {editing ? (
        <input
          ref={inputRef}
          className="h-5 w-full rounded border bg-background px-1 text-sm outline-none ring-1 ring-ring"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
        />
      ) : (
        <div className="flex min-w-0 items-center justify-between gap-1">
          <span
            className="truncate"
            data-selection-key={selectionKey}
            onClick={(e) => {
              e.stopPropagation();
              onExpand?.();
            }}
          >
            {label}
          </span>
          {editable && onRename && (
            <button
              type="button"
              className="invisible flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground group-hover/grid:visible hover:bg-muted hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                startEditing();
              }}
              title="이름 변경"
            >
              <PencilIcon className="size-3" />
            </button>
          )}
        </div>
      )}

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

function StatusPill({
  status,
  pct,
  onClick,
}: {
  status: string;
  pct: number;
  onClick?: () => void;
}) {
  const label =
    status === "completed_elsewhere"
      ? "이전완료"
      : status === "completed"
        ? "완료"
        : status === "inflating"
          ? "해제 중"
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
    status === "completed" || status === "completed_elsewhere"
      ? "text-emerald-600 dark:text-emerald-400"
      : status === "downloading" || status === "inflating"
        ? "text-primary"
        : status === "error"
          ? "text-destructive"
          : "text-muted-foreground";
  const className = cn(
    "inline-block shrink-0 text-right text-xs font-medium tabular-nums",
    status === "completed_elsewhere" ? "min-w-12 w-auto" : "w-12",
    cls,
    onClick && "cursor-pointer underline decoration-dotted underline-offset-2",
  );
  const title =
    status === "completed_elsewhere"
      ? "이전 PC에서 완료됨"
      : status === "inflating"
        ? "압축 해제 중"
        : onClick
          ? "오류 상세 보기"
          : undefined;

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        title={title}
      >
        {label}
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      {label}
    </span>
  );
}
