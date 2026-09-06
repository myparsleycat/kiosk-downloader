import { BulkShareDialog } from "@renderer/components/new-download/bulk-share-dialog";
import { DraftItemCard } from "@renderer/components/new-download/draft-item-card";
import { DraftTreePanel } from "@renderer/components/new-download/draft-tree-panel";
import { RenameDialog, type RenameTarget } from "@renderer/components/tree/rename-dialog";
import { Button } from "@renderer/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@renderer/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@renderer/components/ui/input-group";
import { Label } from "@renderer/components/ui/label";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { useNewDownloadSession } from "@renderer/hooks/use-new-download-session";
import {
  type Collection,
  countFiles,
  dirTotalSize,
  type SortDir,
  type SortField,
  summarizeSelection,
  toggleTreeSelection,
} from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import {
  canStartDownloads,
  getStartableDraftItems,
  hasPreparingDraftItems,
  itemDisplayTree,
  useNewDownloadDraft,
} from "@renderer/stores/new-download-draft";
import { shouldCreateCollectionSubfolder } from "@shared/collection-path";
import { isCollectionExpiresNever } from "@shared/download-errors";
import { isDownloadShareInput, tryDecodeShareUrlBase64 } from "@shared/share-url";
import { basename } from "@shared/tree-rename";
import { formatSize } from "@shared/utils";
import {
  ClockIcon,
  DownloadIcon,
  FileUpIcon,
  FolderOpenIcon,
  HardDriveIcon,
  HashIcon,
  LinkIcon,
  Loader2Icon,
  MenuIcon,
  PackageIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function NewDownloadView({ onCreated }: { onCreated: (downloadId: string) => void }) {
  const url = useNewDownloadDraft((state) => state.url);
  const items = useNewDownloadDraft((state) => state.items);
  const savePath = useNewDownloadDraft((state) => state.savePath);
  const createCollectionSubfolder = useNewDownloadDraft((state) => state.createCollectionSubfolder);
  const setSavePath = useNewDownloadDraft((state) => state.setSavePath);
  const setItemPassword = useNewDownloadDraft((state) => state.setItemPassword);
  const setItemPreparation = useNewDownloadDraft((state) => state.setItemPreparation);
  const updateItemSelected = useNewDownloadDraft((state) => state.updateItemSelected);
  const renameItemNode = useNewDownloadDraft((state) => state.renameItemNode);
  const {
    applyUrlInput,
    commitUrls,
    expandZip,
    extendedLoadProgress,
    handleRemoveItem,
    handleStart,
    loadCollection,
    starting,
    zipPasswordInput,
    zipPasswordPrompt,
    setZipPasswordInput,
    setZipPasswordPrompt,
  } = useNewDownloadSession({ onCreated });

  const readyItem = items.length === 1 && items[0].preparation.status === "ready" ? items[0] : null;
  const collection =
    readyItem?.preparation.status === "ready" ? readyItem.preparation.collection : null;
  const anyPreparing = hasPreparingDraftItems(items);

  const [shareDragOver, setShareDragOver] = React.useState(false);
  const [readingShareFile, setReadingShareFile] = React.useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = React.useState(false);
  const [sortField, setSortField] = React.useState<SortField>("name");
  const [sortDir, setSortDir] = React.useState<SortDir>("none");
  const [renameTarget, setRenameTarget] = React.useState<
    (RenameTarget & { itemKey: string }) | null
  >(null);
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const urlInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    requestAnimationFrame(() => urlInputRef.current?.focus());
  }, []);

  const loadShareFromResult = React.useCallback(
    (result: { shareInput: string } | null) => {
      if (!result) return;
      applyUrlInput(result.shareInput);
    },
    [applyUrlInput],
  );

  const handlePickShareFile = React.useCallback(async () => {
    setReadingShareFile(true);
    try {
      loadShareFromResult(await window.api.invoke("download:readShareFile"));
    } catch (error) {
      toast.error("공유 정보 파일을 읽지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setReadingShareFile(false);
    }
  }, [loadShareFromResult]);

  const handleShareDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setShareDragOver(false);
      const files = collectDroppedFiles(e.dataTransfer);
      if (files.length === 0) return;
      setReadingShareFile(true);
      void window.api
        .readDroppedShareFile(files)
        .then(loadShareFromResult)
        .catch((error: unknown) => {
          toast.error("공유 정보 파일을 읽지 못했습니다", {
            description: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => setReadingShareFile(false));
    },
    [loadShareFromResult],
  );

  const readySummaries = items.flatMap((item) => {
    const tree = itemDisplayTree(item);
    if (!tree) {
      return [];
    }
    const selection = summarizeSelection(item.selected, tree);
    return [
      {
        count: selection.count,
        bytes: selection.bytes,
        totalFiles: countFiles(tree),
        totalBytes: dirTotalSize(tree),
        collectionName: item.preparation.status === "ready" ? item.preparation.collection.name : "",
        tree,
      },
    ];
  });
  const summary = readySummaries.reduce(
    (acc, item) => ({ count: acc.count + item.count, bytes: acc.bytes + item.bytes }),
    { count: 0, bytes: 0 },
  );
  const usesCollectionSubfolder = readySummaries.some(
    (item) =>
      savePath.trim() &&
      shouldCreateCollectionSubfolder(item.tree, item.collectionName, createCollectionSubfolder),
  );

  const handleSortClick = (field: SortField) => {
    if (field === sortField) {
      setSortDir((prev) => (prev === "none" ? "desc" : prev === "desc" ? "asc" : "none"));
      return;
    }
    setSortField(field);
    setSortDir("desc");
  };

  const canStart = canStartDownloads(items, savePath);
  const startableCount = getStartableDraftItems(items).length;
  const effectiveSavePath =
    collection && savePath.trim() && usesCollectionSubfolder
      ? `${savePath.trim().replace(/[/\\]+$/, "")}/${collection.name}`
      : null;

  return (
    <div className="flex h-full">
      <div className="flex w-[320px] min-w-0 shrink-0 flex-col overflow-hidden border-r">
        <div className="border-b px-4 py-3">
          <h2 className="cn-font-heading text-sm font-medium">새 다운로드</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            공유 URL을 입력하거나 확장 공유 파일(.kds)을 선택하세요
          </p>
        </div>

        <ScrollArea className="flex-1">
          <div className="flex w-full min-w-0 flex-col gap-4 p-4">
            <div
              className={cn(
                "flex flex-col gap-1.5 rounded-lg transition-colors",
                shareDragOver && "bg-primary/5 ring-1 ring-primary/30",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setShareDragOver(true);
              }}
              onDragLeave={() => setShareDragOver(false)}
              onDrop={handleShareDrop}
            >
              <Field>
                <FieldLabel htmlFor="url-input">
                  <LinkIcon className="size-3" />
                  공유 URL 또는 확장 공유 파일
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    ref={urlInputRef}
                    id="url-input"
                    placeholder="Kiosk · Transfer.it · Workupload URL 또는 .kds"
                    value={url}
                    onChange={(e) => applyUrlInput(e.target.value)}
                    onPaste={(e) => {
                      const value = e.clipboardData.getData("text").trim();
                      const resolved = tryDecodeShareUrlBase64(value) ?? value;
                      if (!isDownloadShareInput(resolved)) {
                        return;
                      }
                      e.preventDefault();
                      applyUrlInput(resolved);
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    {(readingShareFile || anyPreparing) && (
                      <Loader2Icon className="size-4 animate-spin" />
                    )}
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="공유 정보 파일 선택"
                      disabled={readingShareFile}
                      onClick={() => void handlePickShareFile()}
                    >
                      <FileUpIcon />
                    </InputGroupButton>
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="링크 일괄 추가"
                      disabled={readingShareFile}
                      onClick={() => setBulkDialogOpen(true)}
                    >
                      <MenuIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription className="text-xs">
                  .kds 파일을 드래그하거나 파일 선택 버튼으로 불러올 수 있습니다
                </FieldDescription>
              </Field>
            </div>

            {collection && readyItem ? (
              <CollectionMetaCard
                collection={collection}
                totalFiles={readySummaries[0]?.totalFiles ?? 0}
                totalBytes={readySummaries[0]?.totalBytes ?? 0}
                onRemove={() => handleRemoveItem(readyItem)}
              />
            ) : (
              items.length > 0 && (
                <div className="flex flex-col gap-2">
                  {items.map((item) => (
                    <DraftItemCard
                      key={item.key}
                      item={item}
                      extendedLoadProgress={
                        item.preparation.status === "preparing"
                          ? (extendedLoadProgress[item.url] ?? null)
                          : null
                      }
                      onPasswordChange={(value) => {
                        setItemPassword(item.key, value);
                        if (
                          item.preparation.status === "passwordRequired" &&
                          item.preparation.invalid
                        ) {
                          setItemPreparation(item.key, {
                            status: "passwordRequired",
                            invalid: false,
                          });
                        }
                      }}
                      onVerifyPassword={() => {
                        if (!item.password.trim()) {
                          return;
                        }
                        void loadCollection(item.key, item.url, item.password);
                      }}
                      onRetry={() => {
                        void loadCollection(item.key, item.url, item.password || undefined);
                      }}
                      onRemove={() => handleRemoveItem(item)}
                    />
                  ))}
                </div>
              )
            )}
          </div>
        </ScrollArea>

        <div className="border-t p-3">
          <div className="mb-3 flex flex-col gap-1.5">
            <Label className="flex items-center gap-1.5 text-xs">
              <FolderOpenIcon className="size-3" />
              저장 경로
            </Label>
            <div className="flex gap-1.5">
              <Input value={savePath} onChange={(e) => setSavePath(e.target.value)} />
              <Button
                variant="outline"
                size="icon"
                onClick={async () => {
                  const result = await window.api.invoke("util:showOpenDialog", {
                    properties: ["openDirectory"],
                    ...(savePath.trim() ? { defaultPath: savePath.trim() } : {}),
                  });

                  if (result.canceled || result.filePaths.length === 0) {
                    return null;
                  }

                  setSavePath(result.filePaths[0]);
                  return;
                }}
              >
                <FolderOpenIcon className="size-4" />
              </Button>
            </div>
            {effectiveSavePath ? (
              <p className="truncate text-xs text-muted-foreground" title={effectiveSavePath}>
                실제 저장: {effectiveSavePath}
              </p>
            ) : items.length > 1 && usesCollectionSubfolder ? (
              <p className="truncate text-xs text-muted-foreground">
                실제 저장: {savePath.trim()}/[컬렉션 이름]
              </p>
            ) : null}
          </div>
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">선택</span>
            <span className="font-medium tabular-nums">
              {summary.count}개 · {formatSize(summary.bytes)}
            </span>
          </div>
          <Button
            className="w-full"
            disabled={!canStart}
            isLoading={starting}
            onClick={() => void handleStart()}
          >
            <DownloadIcon className="size-3.5" />
            {items.length > 1 ? `${startableCount}개 다운로드 시작` : "다운로드 시작"}
          </Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col">
        <DraftTreePanel
          items={items}
          sortField={sortField}
          sortDir={sortDir}
          onSort={handleSortClick}
          onToggle={(item, key) => {
            const tree = itemDisplayTree(item);
            if (!tree) return;
            updateItemSelected(item.key, (prev) => toggleTreeSelection(prev, key, tree));
          }}
          onExpandZip={(item, zipPath, fileId) => {
            if (item.preparation.status !== "ready") return;
            if (item.preparation.collection.provider !== "kiosk") return;
            void expandZip(item.key, zipPath, fileId, item.zipPasswords[fileId]);
          }}
          onRename={(item, key, kind) => {
            setRenameError(null);
            setRenameTarget({ itemKey: item.key, path: key, name: basename(key), kind });
          }}
        />
      </div>

      <BulkShareDialog
        open={bulkDialogOpen}
        onOpenChange={setBulkDialogOpen}
        onConfirm={(urls) => void commitUrls(urls)}
      />

      <RenameDialog
        target={renameTarget}
        error={renameError}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
            setRenameError(null);
          }
        }}
        onConfirm={(nextName) => {
          if (!renameTarget) {
            return;
          }
          const item = useNewDownloadDraft
            .getState()
            .items.find((candidate) => candidate.key === renameTarget.itemKey);
          const tree = item ? itemDisplayTree(item) : null;
          if (!item || !tree) {
            return;
          }
          const error = renameItemNode(renameTarget.itemKey, renameTarget.path, nextName, tree);
          if (error) {
            setRenameError(error);
            return;
          }
          setRenameTarget(null);
          setRenameError(null);
        }}
      />

      <Dialog
        open={zipPasswordPrompt !== null}
        onOpenChange={(open) => {
          if (!open) {
            setZipPasswordPrompt(null);
            setZipPasswordInput("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>ZIP 비밀번호</DialogTitle>
            <DialogDescription>
              {zipPasswordPrompt?.path ?? "선택한 ZIP"} 파일을 열려면 비밀번호가 필요합니다.
            </DialogDescription>
          </DialogHeader>
          <Field {...(zipPasswordPrompt?.invalid ? { "data-invalid": true } : {})}>
            <FieldLabel htmlFor="zip-password-input">비밀번호</FieldLabel>
            <Input
              id="zip-password-input"
              type="password"
              value={zipPasswordInput}
              aria-invalid={zipPasswordPrompt?.invalid || undefined}
              onChange={(event) => setZipPasswordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !zipPasswordPrompt) {
                  return;
                }
                event.preventDefault();
                void expandZip(
                  zipPasswordPrompt.itemKey,
                  zipPasswordPrompt.path,
                  zipPasswordPrompt.fileId,
                  zipPasswordInput,
                );
              }}
            />
            {zipPasswordPrompt?.invalid ? (
              <FieldDescription>비밀번호가 올바르지 않습니다.</FieldDescription>
            ) : null}
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setZipPasswordPrompt(null);
                setZipPasswordInput("");
              }}
            >
              취소
            </Button>
            <Button
              onClick={() => {
                if (!zipPasswordPrompt) {
                  return;
                }
                void expandZip(
                  zipPasswordPrompt.itemKey,
                  zipPasswordPrompt.path,
                  zipPasswordPrompt.fileId,
                  zipPasswordInput,
                );
              }}
            >
              확인
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CollectionMetaCard({
  collection,
  totalFiles,
  totalBytes,
  onRemove,
}: {
  collection: Collection;
  totalFiles: number;
  totalBytes: number;
  onRemove: () => void;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 overflow-hidden rounded-lg border bg-muted/30 p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <MetaRow icon={<PackageIcon className="size-3" />} label="이름" title={collection.name}>
          {collection.name}
        </MetaRow>
        <MetaRow
          icon={<HashIcon className="size-3" />}
          label={
            collection.provider === "workupload"
              ? collection.resource === "archive"
                ? "Workupload Archive ID"
                : "Workupload File ID"
              : "Share ID"
          }
        >
          <span className="font-mono text-[11px]">{collection.shareId}</span>
        </MetaRow>
        <MetaRow icon={<ClockIcon className="size-3" />} label="만료">
          {isCollectionExpiresNever(collection.expires)
            ? "없음"
            : new Date(collection.expires * 1000).toLocaleString("ko-KR")}
        </MetaRow>
        <MetaRow icon={<HardDriveIcon className="size-3" />} label="총 파일">
          {totalFiles}개 · {formatSize(totalBytes)}
        </MetaRow>
      </div>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="제거" onClick={onRemove}>
        <XIcon />
      </Button>
    </div>
  );
}

function MetaRow({
  icon,
  label,
  title,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <span className="flex w-16 shrink-0 items-center gap-1 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate" title={title}>
        {children}
      </span>
    </div>
  );
}

function collectDroppedFiles(dataTransfer: DataTransfer): File[] {
  const items = dataTransfer.items;
  if (!items || items.length === 0) return [];
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}
