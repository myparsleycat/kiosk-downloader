import { FileTree } from "@renderer/components/tree/file-tree";
import { RenameDialog, type RenameTarget } from "@renderer/components/tree/rename-dialog";
import { Badge } from "@renderer/components/ui/badge";
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
import { Separator } from "@renderer/components/ui/separator";
import {
  collectAllPaths,
  countFiles,
  dirTotalSize,
  selectExpandedZipEntries,
  type SortDir,
  type SortField,
  sortTree,
  summarizeSelection,
  toggleTreeSelection,
} from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import { applyZipEntriesResult, useNewDownloadDraft } from "@renderer/stores/new-download-draft";
import { shouldCreateCollectionSubfolder } from "@shared/collection-path";
import { getIpcErrorCause, isCollectionExpiresNever } from "@shared/download-errors";
import {
  EXTENDED_SHARE_PREFIX,
  tryDecodeShareUrlBase64,
  tryParseDownloadUrl,
} from "@shared/share-url";
import { applyRenamesToTree, basename } from "@shared/tree-rename";
import { formatSize } from "@shared/utils";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ClockIcon,
  DownloadIcon,
  FileUpIcon,
  FolderOpenIcon,
  HardDriveIcon,
  HashIcon,
  LinkIcon,
  Loader2Icon,
  LockIcon,
  PackageIcon,
  RefreshCwIcon,
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
  const password = useNewDownloadDraft((state) => state.password);
  const savePath = useNewDownloadDraft((state) => state.savePath);
  const createCollectionSubfolder = useNewDownloadDraft((state) => state.createCollectionSubfolder);
  const preparation = useNewDownloadDraft((state) => state.preparation);
  const collection = preparation.status === "ready" ? preparation.collection : null;
  const draftId = preparation.status === "ready" ? preparation.draftId : null;
  const passwordRequired = preparation.status === "passwordRequired";
  const passwordInvalid = passwordRequired && preparation.invalid;
  const loading = preparation.status === "preparing";
  const selected = useNewDownloadDraft((state) => state.selected);
  const setUrl = useNewDownloadDraft((state) => state.setUrl);
  const setPassword = useNewDownloadDraft((state) => state.setPassword);
  const setSavePath = useNewDownloadDraft((state) => state.setSavePath);
  const setPreparation = useNewDownloadDraft((state) => state.setPreparation);
  const setSelected = useNewDownloadDraft((state) => state.setSelected);
  const updateSelected = useNewDownloadDraft((state) => state.updateSelected);
  const clearPreparation = useNewDownloadDraft((state) => state.clearPreparation);
  const resetDraft = useNewDownloadDraft((state) => state.resetDraft);
  const hydrateSettings = useNewDownloadDraft((state) => state.hydrateSettings);
  const zipPasswords = useNewDownloadDraft((state) => state.zipPasswords);
  const zipLoadingPaths = useNewDownloadDraft((state) => state.zipLoadingPaths);
  const renames = useNewDownloadDraft((state) => state.renames);
  const setZipPassword = useNewDownloadDraft((state) => state.setZipPassword);
  const setZipLoading = useNewDownloadDraft((state) => state.setZipLoading);
  const renameNode = useNewDownloadDraft((state) => state.renameNode);

  const [shareDragOver, setShareDragOver] = React.useState(false);
  const [readingShareFile, setReadingShareFile] = React.useState(false);
  const [extendedLoadProgress, setExtendedLoadProgress] = React.useState<{
    current: number;
    total: number;
  } | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [sortField, setSortField] = React.useState<SortField>("name");
  const [sortDir, setSortDir] = React.useState<SortDir>("none");
  const [zipPasswordPrompt, setZipPasswordPrompt] = React.useState<{
    path: string;
    fileId: string;
    invalid: boolean;
  } | null>(null);
  const [zipPasswordInput, setZipPasswordInput] = React.useState("");
  const [renameTarget, setRenameTarget] = React.useState<RenameTarget | null>(null);
  const [renameError, setRenameError] = React.useState<string | null>(null);

  const loadSeqRef = React.useRef(0);
  const draftIdRef = React.useRef<string | null>(draftId);
  const urlInputRef = React.useRef<HTMLInputElement>(null);
  const passwordInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);

  React.useEffect(() => {
    draftIdRef.current = draftId;
  }, [draftId]);

  React.useEffect(
    () => () => {
      void window.api.invoke("download:discardDraft", {
        draftId: draftIdRef.current ?? undefined,
      });
      resetDraft();
    },
    [resetDraft],
  );

  React.useEffect(() => {
    requestAnimationFrame(() => urlInputRef.current?.focus());
  }, []);

  React.useEffect(
    () =>
      window.api.on("download:extended-load-progress", (progress) =>
        setExtendedLoadProgress(progress),
      ),
    [],
  );

  const loadShareFromResult = React.useCallback(
    (result: { shareInput: string } | null) => {
      if (!result) return;
      setUrl(result.shareInput);
    },
    [setUrl],
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

  const loadCollection = React.useCallback(
    async (trimmedUrl: string, loadPassword?: string) => {
      const parsed = tryParseDownloadUrl(trimmedUrl);
      const extended = trimmedUrl.startsWith(EXTENDED_SHARE_PREFIX);
      if (!parsed && !extended) {
        return;
      }

      const seq = ++loadSeqRef.current;
      setPreparation({ status: "preparing" });
      setExtendedLoadProgress(extended ? { current: 0, total: 0 } : null);

      try {
        await hydrateSettings();
        const result = await window.api.invoke("download:prepare", {
          url: trimmedUrl,
          password: loadPassword || undefined,
          asciiFilenames: useNewDownloadDraft.getState().asciiFilenames,
        });

        if (seq !== loadSeqRef.current) {
          return;
        }

        if (result.status === "ready") {
          setPreparation(result);
          setSelected(collectAllPaths(result.collection.tree));
          return;
        }
        if (result.status === "passwordRequired") {
          setPreparation(result);
          setSelected(new Set());
          requestAnimationFrame(() => passwordInputRef.current?.focus());
          return;
        }
        setPreparation({ status: "error", message: result.message });
        setSelected(new Set());
        toast.error("컬렉션을 불러오지 못했습니다", { description: result.message });
      } catch (error) {
        if (seq !== loadSeqRef.current) {
          return;
        }
        const message = getIpcErrorCause(error);
        setPreparation({ status: "error", message });
        setSelected(new Set());
        toast.error("컬렉션을 불러오지 못했습니다", {
          description: message,
        });
      } finally {
        if (seq === loadSeqRef.current) {
          setExtendedLoadProgress(null);
        }
      }
    },
    [hydrateSettings, setPreparation, setSelected],
  );

  const verifyPassword = React.useCallback(() => {
    const trimmedUrl = url.trim();
    if (
      !passwordRequired ||
      !password.trim() ||
      (!tryParseDownloadUrl(trimmedUrl) && !trimmedUrl.startsWith(EXTENDED_SHARE_PREFIX))
    ) {
      return;
    }

    void loadCollection(trimmedUrl, password);
  }, [loadCollection, password, passwordRequired, url]);

  React.useEffect(() => {
    const trimmedUrl = url.trim();
    const parsed = tryParseDownloadUrl(trimmedUrl);
    const valid = parsed || trimmedUrl.startsWith(EXTENDED_SHARE_PREFIX);

    if (!valid) {
      loadSeqRef.current += 1;
      void window.api.invoke("download:discardDraft", {
        draftId: draftIdRef.current ?? undefined,
      });
      draftIdRef.current = null;
      clearPreparation();
      return;
    }
    clearPreparation();
    void loadCollection(trimmedUrl);
  }, [clearPreparation, loadCollection, url]);

  const displayTree = React.useMemo(
    () => (collection ? applyRenamesToTree(collection.tree, renames) : null),
    [collection, renames],
  );

  const handleToggle = (key: string) => {
    if (!displayTree) return;
    updateSelected((prev) => toggleTreeSelection(prev, key, displayTree));
  };

  const expandZip = React.useCallback(
    async (zipPath: string, fileId: string, zipPassword?: string) => {
      if (!collection || !draftId) {
        return;
      }
      const requestedDraftId = draftId;
      setZipLoading(zipPath, true);
      try {
        const result = await window.api.invoke("download:listZipEntries", {
          draftId: requestedDraftId,
          fileId,
          zipPassword,
        });
        const applied = applyZipEntriesResult(
          requestedDraftId,
          useNewDownloadDraft.getState().preparation,
          result,
          fileId,
        );
        if (applied.action === "ignore") {
          return;
        }
        if (applied.action === "passwordRequired") {
          setZipPasswordPrompt({ path: zipPath, fileId, invalid: applied.invalid });
          return;
        }
        if (applied.action === "clear") {
          clearPreparation();
          toast.error("ZIP 목록을 불러오지 못했습니다", {
            description: result.status === "failed" ? result.message : undefined,
          });
          return;
        }
        if (applied.action === "failed") {
          toast.error("ZIP 목록을 불러오지 못했습니다", {
            description: result.status === "failed" ? result.message : undefined,
          });
          return;
        }
        const current = useNewDownloadDraft.getState().preparation;
        if (current.status !== "ready" || current.draftId !== requestedDraftId) {
          return;
        }
        if (zipPassword) {
          setZipPassword(fileId, zipPassword);
        }
        setPreparation({
          status: "ready",
          draftId: requestedDraftId,
          collection: { ...current.collection, tree: applied.nextTree },
        });
        updateSelected((prev) => selectExpandedZipEntries(prev, applied.nextTree, zipPath, fileId));
        setZipPasswordPrompt(null);
        setZipPasswordInput("");
      } catch (error) {
        toast.error("ZIP 목록을 불러오지 못했습니다", {
          description: getIpcErrorCause(error),
        });
      } finally {
        setZipLoading(zipPath, false);
      }
    },
    [
      clearPreparation,
      collection,
      draftId,
      setPreparation,
      setZipLoading,
      setZipPassword,
      updateSelected,
    ],
  );

  const handleExpandZip = (zipPath: string, fileId: string) => {
    void expandZip(zipPath, fileId, zipPasswords[fileId]);
  };

  const summary = displayTree ? summarizeSelection(selected, displayTree) : { count: 0, bytes: 0 };
  const totalFiles = displayTree ? countFiles(displayTree) : 0;
  const totalBytes = displayTree ? dirTotalSize(displayTree) : 0;

  const sortedTree = React.useMemo(
    () =>
      displayTree
        ? sortDir !== "none"
          ? sortTree(displayTree, sortField, sortDir)
          : displayTree
        : undefined,
    [displayTree, sortField, sortDir],
  );

  const handleSortClick = (field: SortField) => {
    if (field === sortField) {
      setSortDir((prev) => (prev === "none" ? "desc" : prev === "desc" ? "asc" : "none"));
      return;
    }
    setSortField(field);
    setSortDir("desc");
  };

  const canStart =
    collection !== null &&
    draftId !== null &&
    summary.count > 0 &&
    savePath.trim().length > 0 &&
    !loading;
  const effectiveSavePath =
    displayTree &&
    collection &&
    savePath.trim() &&
    shouldCreateCollectionSubfolder(displayTree, collection.name, createCollectionSubfolder)
      ? `${savePath.trim().replace(/[/\\]+$/, "")}/${collection.name}`
      : null;

  const handleStart = async () => {
    if (!collection || !draftId || !canStart || loading) {
      return;
    }
    setStarting(true);
    try {
      const created = await window.api.invoke("download:create", {
        draftId,
        savePath: savePath.trim(),
        selectedPaths: [...selected],
        zipPasswords: Object.keys(zipPasswords).length > 0 ? zipPasswords : undefined,
        renames: Object.keys(renames).length > 0 ? renames : undefined,
      });
      if (!created) {
        throw new Error("다운로드 항목을 만들지 못했습니다.");
      }
      toast.success("다운로드가 대기열에 추가되었습니다", {
        description: `${collection.name} · ${summary.count}개 파일`,
      });
      resetDraft();
      onCreated(created.id);
    } catch (error) {
      toast.error("다운로드를 시작하지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };

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
                    onChange={(e) => {
                      const value = e.target.value;
                      setUrl(tryDecodeShareUrlBase64(value) ?? value);
                    }}
                    onPaste={(e) => {
                      const value = e.clipboardData.getData("text").trim();
                      const resolved = tryDecodeShareUrlBase64(value) ?? value;
                      if (
                        !tryParseDownloadUrl(resolved) &&
                        !resolved.startsWith(EXTENDED_SHARE_PREFIX)
                      ) {
                        return;
                      }
                      e.preventDefault();
                      setUrl(resolved);
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    {(loading || readingShareFile) && (
                      <Loader2Icon className="size-4 animate-spin" />
                    )}
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="공유 정보 파일 선택"
                      disabled={readingShareFile || loading}
                      onClick={() => void handlePickShareFile()}
                    >
                      <FileUpIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription className="text-xs">
                  .kds 파일을 드래그하거나 파일 선택 버튼으로 불러올 수 있습니다
                </FieldDescription>
                {loading && extendedLoadProgress && extendedLoadProgress.total > 0 && (
                  <FieldDescription className="text-xs">
                    컬렉션 {extendedLoadProgress.current}/{extendedLoadProgress.total} 불러오는 중
                  </FieldDescription>
                )}
              </Field>
            </div>

            {passwordRequired === true && (
              <div className="flex flex-col gap-1.5">
                <Field {...(passwordInvalid ? { "data-invalid": true } : {})}>
                  <FieldLabel htmlFor="password-input" className="text-xs">
                    <LockIcon className="size-3" />
                    비밀번호
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      ref={passwordInputRef}
                      id="password-input"
                      placeholder="비밀번호 입력"
                      value={password}
                      aria-invalid={passwordInvalid || undefined}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (passwordInvalid) {
                          setPreparation({ status: "passwordRequired", invalid: false });
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        verifyPassword();
                      }}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        size="icon-xs"
                        disabled={!password.trim() || loading}
                        aria-label="비밀번호 확인"
                        onClick={verifyPassword}
                      >
                        {loading ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  {passwordInvalid && (
                    <FieldDescription className="text-xs">잘못된 비밀번호 입니다.</FieldDescription>
                  )}
                </Field>
              </div>
            )}

            {collection && (
              <>
                <Separator />
                <div className="flex min-w-0 flex-col gap-2 overflow-hidden rounded-lg border bg-muted/30 p-3">
                  <MetaRow
                    icon={<PackageIcon className="size-3" />}
                    label="이름"
                    title={collection.name}
                  >
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
              </>
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
            {effectiveSavePath && (
              <p className="truncate text-xs text-muted-foreground" title={effectiveSavePath}>
                실제 저장: {effectiveSavePath}
              </p>
            )}
          </div>
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">선택</span>
            <span className="font-medium tabular-nums">
              {summary.count}개 · {formatSize(summary.bytes)}
            </span>
          </div>
          <Button
            className="w-full"
            disabled={!canStart || loading}
            isLoading={starting}
            onClick={handleStart}
          >
            <DownloadIcon className="size-3.5" />
            다운로드 시작
          </Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col">
        {collection ? (
          <>
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <div>
                <span className="cn-font-heading text-sm font-medium">파일 선택</span>
                {collection.provider === "extended" && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    확장 공유의 ZIP은 완성 파일로 다운로드되며 내부 목록은 미리 열 수 없습니다.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="tabular-nums">{summary.count}</span>
                <span>/</span>
                <span className="tabular-nums">{totalFiles} 파일</span>
              </div>
            </div>
            <SortHeader field={sortField} dir={sortDir} onSort={handleSortClick} />
            <ScrollArea className="flex-1">
              <div className="p-2">
                <FileTree
                  mode="selection"
                  root={sortedTree ?? displayTree ?? collection.tree}
                  selected={selected}
                  onToggle={handleToggle}
                  onExpandZip={collection.provider === "kiosk" ? handleExpandZip : undefined}
                  zipLoadingPaths={zipLoadingPaths}
                  onRename={(key, kind) => {
                    setRenameError(null);
                    setRenameTarget({ path: key, name: basename(key), kind });
                  }}
                />
              </div>
            </ScrollArea>
          </>
        ) : (
          <EmptyState loading={loading} />
        )}
      </div>

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
          if (!renameTarget || !displayTree) {
            return;
          }
          const error = renameNode(renameTarget.path, nextName, displayTree);
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
                void expandZip(zipPasswordPrompt.path, zipPasswordPrompt.fileId, zipPasswordInput);
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
                void expandZip(zipPasswordPrompt.path, zipPasswordPrompt.fileId, zipPasswordInput);
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

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      {loading ? (
        <RefreshCwIcon className="size-8 animate-spin opacity-50" />
      ) : (
        <DownloadIcon className="size-8 opacity-30" />
      )}
      <span className="text-sm">
        {loading ? "컬렉션을 불러오는 중..." : "좌측에서 URL 또는 공유 파일을 불러오세요"}
      </span>
      {!loading && (
        <div className="flex flex-wrap items-center justify-center gap-1.5 px-6">
          {SUPPORTED_PROVIDERS.map((name) => (
            <Badge key={name} variant="outline" className="text-muted-foreground">
              {name}
            </Badge>
          ))}
        </div>
      )}
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
