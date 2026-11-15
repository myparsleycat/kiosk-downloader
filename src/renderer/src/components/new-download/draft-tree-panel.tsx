import {
  FILE_TREE_RIGHT_COLS,
  FILE_TREE_ROW_INSET,
  FileTree,
  fileTreeGridTemplateColumns,
} from "@renderer/components/tree/file-tree";
import { Badge } from "@renderer/components/ui/badge";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { useSortedTree } from "@renderer/hooks/use-sorted-tree";
import {
  countFiles,
  getTreeSelectionState,
  type SortDir,
  type SortField,
  summarizeSelection,
} from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import { itemDisplayTree, type NewDownloadItem } from "@renderer/stores/new-download-draft";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  Loader2Icon,
  LockIcon,
} from "lucide-react";

// The sort header lines up with root rows by summing every inset that sits in front of them.
const LIST_PADDING = 8;
const SECTION_BORDER = 1;
const SECTION_PADDING = 8;

export function DraftTreePanel({
  items,
  sortField,
  sortDir,
  onSort,
  onToggle,
  onSetAllSelected,
  onExpandZip,
  onRename,
}: {
  items: NewDownloadItem[];
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
  onToggle: (item: NewDownloadItem, key: string) => void;
  onSetAllSelected: (itemKeys: string[], selected: boolean) => void;
  onExpandZip: (item: NewDownloadItem, zipPath: string, fileId: string) => void;
  onRename: (item: NewDownloadItem, key: string, kind: "file" | "dir" | "zip") => void;
}) {
  if (items.length === 0) {
    return <EmptyState />;
  }

  const readyTrees = items.flatMap((item) => {
    const tree = itemDisplayTree(item);
    return tree ? [{ item, tree }] : [];
  });
  const summary = readyTrees.reduce(
    (acc, ready) => ({
      count: acc.count + summarizeSelection(ready.item.selected, ready.tree).count,
      files: acc.files + countFiles(ready.tree),
    }),
    { count: 0, files: 0 },
  );
  const selectableTrees = readyTrees.filter((ready) => ready.tree.entries.length > 0);
  const selectionStates = selectableTrees.map((ready) =>
    getTreeSelectionState(ready.item.selected, ready.tree),
  );
  const allSelected =
    selectionStates.length > 0 && selectionStates.every((state) => state === true)
      ? true
      : selectionStates.some((state) => state !== false)
        ? "indeterminate"
        : false;

  return (
    <>
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="cn-font-heading text-sm font-medium">파일 선택</span>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="tabular-nums">{summary.count}</span>
          <span>/</span>
          <span className="tabular-nums">{summary.files} 파일</span>
        </div>
      </div>
      <SortHeader
        field={sortField}
        dir={sortDir}
        onSort={onSort}
        checked={allSelected}
        disabled={selectableTrees.length === 0}
        framed={items.length > 1}
        onToggleAll={() =>
          onSetAllSelected(
            selectableTrees.map((ready) => ready.item.key),
            allSelected !== true,
          )
        }
      />
      <ScrollArea className="flex-1">
        <div
          className={items.length > 1 ? "flex flex-col gap-4" : undefined}
          style={{ padding: LIST_PADDING }}
        >
          {items.map((item) => (
            <DraftTreeSection
              key={item.key}
              item={item}
              framed={items.length > 1}
              sortField={sortField}
              sortDir={sortDir}
              onToggle={(key) => onToggle(item, key)}
              onSetAllSelected={(selected) => onSetAllSelected([item.key], selected)}
              onExpandZip={(zipPath, fileId) => onExpandZip(item, zipPath, fileId)}
              onRename={(key, kind) => onRename(item, key, kind)}
            />
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

function DraftTreeSection({
  item,
  framed,
  sortField,
  sortDir,
  onToggle,
  onSetAllSelected,
  onExpandZip,
  onRename,
}: {
  item: NewDownloadItem;
  framed: boolean;
  sortField: SortField;
  sortDir: SortDir;
  onToggle: (key: string) => void;
  onSetAllSelected: (selected: boolean) => void;
  onExpandZip: (zipPath: string, fileId: string) => void;
  onRename: (key: string, kind: "file" | "dir" | "zip") => void;
}) {
  const tree = itemDisplayTree(item);
  const title = item.preparation.status === "ready" ? item.preparation.collection.name : item.url;
  const selectedSummary = tree ? summarizeSelection(item.selected, tree) : { count: 0, bytes: 0 };
  const files = tree ? countFiles(tree) : 0;
  const sorted = useSortedTree(tree, sortField, sortDir);
  const selectionState = tree ? getTreeSelectionState(item.selected, tree) : false;
  const body =
    item.preparation.status === "ready" && sorted ? (
      <div style={framed ? { padding: SECTION_PADDING } : undefined}>
        {item.preparation.collection.provider === "extended" && (
          <p className="mb-2 px-1 text-[11px] text-muted-foreground">
            확장 공유의 ZIP은 완성 파일로 다운로드되며 내부 목록은 미리 열 수 없습니다.
          </p>
        )}
        <FileTree
          mode="selection"
          root={sorted}
          selected={item.selected}
          onToggle={onToggle}
          onExpandZip={item.preparation.collection.provider === "kiosk" ? onExpandZip : undefined}
          zipLoadingPaths={item.zipLoadingPaths}
          onRename={onRename}
        />
      </div>
    ) : (
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
        {item.preparation.status === "preparing" ? (
          <>
            <Loader2Icon className="size-3.5 animate-spin" />
            컬렉션을 불러오는 중
          </>
        ) : item.preparation.status === "passwordRequired" ? (
          <>
            <LockIcon className="size-3.5" />
            비밀번호가 필요합니다
          </>
        ) : item.preparation.status === "error" ? (
          <span className="text-destructive">{item.preparation.message}</span>
        ) : (
          "컬렉션을 불러오세요"
        )}
      </div>
    );

  if (!framed) {
    return body;
  }

  return (
    <section className="overflow-hidden rounded-lg border" style={{ borderWidth: SECTION_BORDER }}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {tree ? (
            <SelectAllCheckbox
              checked={selectionState}
              onToggle={() => onSetAllSelected(selectionState !== true)}
            />
          ) : null}
          <p className="min-w-0 truncate text-xs font-medium" title={title}>
            {title}
          </p>
        </div>
        {tree ? (
          <p className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {selectedSummary.count}/{files}
          </p>
        ) : null}
      </div>
      {body}
    </section>
  );
}

function SelectAllCheckbox({
  checked,
  disabled,
  onToggle,
}: {
  checked: boolean | "indeterminate";
  disabled?: boolean;
  onToggle: () => void;
}) {
  const label = checked === true ? "전체 해제" : "전체 선택";
  return (
    <Checkbox
      checked={checked === true}
      indeterminate={checked === "indeterminate"}
      disabled={disabled}
      onCheckedChange={onToggle}
      aria-label={label}
      title={label}
      className="after:hidden"
    />
  );
}

function SortHeader({
  field,
  dir,
  onSort,
  checked,
  disabled,
  framed,
  onToggleAll,
}: {
  field: SortField;
  dir: SortDir;
  onSort: (field: SortField) => void;
  checked: boolean | "indeterminate";
  disabled: boolean;
  framed: boolean;
  onToggleAll: () => void;
}) {
  return (
    <div
      className="grid items-center gap-x-1 border-b py-1 text-xs text-muted-foreground"
      style={{
        gridTemplateColumns: fileTreeGridTemplateColumns(FILE_TREE_RIGHT_COLS.selection),
        paddingInline:
          LIST_PADDING + FILE_TREE_ROW_INSET + (framed ? SECTION_BORDER + SECTION_PADDING : 0),
      }}
    >
      <span className="flex items-center gap-1">
        <span className="size-4 shrink-0" />
        <SelectAllCheckbox checked={checked} disabled={disabled} onToggle={onToggleAll} />
        <span className="size-4 shrink-0" />
      </span>
      <SortButton
        label="이름"
        active={dir !== "none" && field === "name"}
        dir={field === "name" ? dir : "none"}
        onClick={() => onSort("name")}
      />
      <div className="flex justify-end">
        <SortButton
          label="크기"
          active={dir !== "none" && field === "size"}
          dir={field === "size" ? dir : "none"}
          onClick={() => onSort("size")}
        />
      </div>
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

const SUPPORTED_PROVIDERS = [
  "Kiosk",
  "Transfer.it",
  "Workupload",
  "Mega",
  "직접 링크",
  "확장 공유 (.kds)",
] as const;

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <DownloadIcon className="size-8 opacity-30" />
      <span className="text-sm">좌측에서 URL 또는 공유 파일을 불러오세요</span>
      <div className="flex flex-wrap items-center justify-center gap-1.5 px-6">
        {SUPPORTED_PROVIDERS.map((name) => (
          <Badge key={name} variant="outline" className="text-muted-foreground">
            {name}
          </Badge>
        ))}
      </div>
    </div>
  );
}
