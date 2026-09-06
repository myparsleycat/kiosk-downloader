import { FileTree } from "@renderer/components/tree/file-tree";
import { Badge } from "@renderer/components/ui/badge";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import {
  countFiles,
  type SortDir,
  type SortField,
  sortTree,
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

export function DraftTreePanel({
  items,
  sortField,
  sortDir,
  onSort,
  onToggle,
  onExpandZip,
  onRename,
}: {
  items: NewDownloadItem[];
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
  onToggle: (item: NewDownloadItem, key: string) => void;
  onExpandZip: (item: NewDownloadItem, zipPath: string, fileId: string) => void;
  onRename: (item: NewDownloadItem, key: string, kind: "file" | "dir" | "zip") => void;
}) {
  if (items.length === 0) {
    return <EmptyState />;
  }

  const summary = items.reduce(
    (acc, item) => {
      const tree = itemDisplayTree(item);
      if (!tree) {
        return acc;
      }
      const selection = summarizeSelection(item.selected, tree);
      return {
        count: acc.count + selection.count,
        files: acc.files + countFiles(tree),
      };
    },
    { count: 0, files: 0 },
  );

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
      <SortHeader field={sortField} dir={sortDir} onSort={onSort} />
      <ScrollArea className="flex-1">
        <div className={items.length > 1 ? "flex flex-col gap-4 p-2" : "p-2"}>
          {items.map((item) => (
            <DraftTreeSection
              key={item.key}
              item={item}
              framed={items.length > 1}
              sortField={sortField}
              sortDir={sortDir}
              onToggle={(key) => onToggle(item, key)}
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
  onExpandZip,
  onRename,
}: {
  item: NewDownloadItem;
  framed: boolean;
  sortField: SortField;
  sortDir: SortDir;
  onToggle: (key: string) => void;
  onExpandZip: (zipPath: string, fileId: string) => void;
  onRename: (key: string, kind: "file" | "dir" | "zip") => void;
}) {
  const tree = itemDisplayTree(item);
  const title = item.preparation.status === "ready" ? item.preparation.collection.name : item.url;
  const selectedSummary = tree ? summarizeSelection(item.selected, tree) : { count: 0, bytes: 0 };
  const files = tree ? countFiles(tree) : 0;
  const sorted = tree && sortDir !== "none" ? sortTree(tree, sortField, sortDir) : tree;
  const body =
    item.preparation.status === "ready" && sorted ? (
      <div className={framed ? "p-2" : undefined}>
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
    <section className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <p className="min-w-0 truncate text-xs font-medium" title={title}>
          {title}
        </p>
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

function SortHeader({
  field,
  dir,
  onSort,
}: {
  field: SortField;
  dir: SortDir;
  onSort: (field: SortField) => void;
}) {
  return (
    <div className="grid items-center gap-x-1 border-b px-2 py-1 text-xs text-muted-foreground grid-cols-[auto_minmax(0,1fr)_4rem]">
      <span className="flex items-center gap-1">
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

const SUPPORTED_PROVIDERS = ["Kiosk", "Transfer.it", "Workupload", "확장 공유 (.kds)"] as const;

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
