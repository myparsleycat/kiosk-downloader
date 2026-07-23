import { FileTree } from "@renderer/components/tree/file-tree";
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
import { useNewDownloadDraft } from "@renderer/stores/new-download-draft";
import { shouldCreateCollectionSubfolder } from "@shared/collection-path";
import {
  getIpcErrorCause,
  isCollectionExpiresNever,
  isCollectionInvalidPasswordError,
  isCollectionPasswordRequiredError,
  isExtendedShareInvalidPasswordError,
  isExtendedSharePasswordRequiredError,
  isZipInvalidPasswordError,
  isZipPasswordRequiredError,
} from "@shared/download-errors";
import { tryDecodeShareUrlBase64, tryParseDownloadUrl } from "@shared/share-url";
import { applyRenamesToTree, basename } from "@shared/tree-rename";
import { formatSize } from "@shared/utils";
import { setZipEntries } from "@shared/zip-tree";
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
  const passwordRequired = useNewDownloadDraft((state) => state.passwordRequired);
  const passwordInvalid = useNewDownloadDraft((state) => state.passwordInvalid);
  const collection = useNewDownloadDraft((state) => state.collection);
  const selected = useNewDownloadDraft((state) => state.selected);
  const probedShareId = useNewDownloadDraft((state) => state.probedShareId);
  const setUrl = useNewDownloadDraft((state) => state.setUrl);
  const setPassword = useNewDownloadDraft((state) => state.setPassword);
  const setSavePath = useNewDownloadDraft((state) => state.setSavePath);
  const setPasswordRequired = useNewDownloadDraft((state) => state.setPasswordRequired);
  const setPasswordInvalid = useNewDownloadDraft((state) => state.setPasswordInvalid);
  const setCollection = useNewDownloadDraft((state) => state.setCollection);
  const setSelected = useNewDownloadDraft((state) => state.setSelected);
  const updateSelected = useNewDownloadDraft((state) => state.updateSelected);
  const setProbedShareId = useNewDownloadDraft((state) => state.setProbedShareId);
  const clearProbeState = useNewDownloadDraft((state) => state.clearProbeState);
  const resetDraft = useNewDownloadDraft((state) => state.resetDraft);
  const hydrateSettings = useNewDownloadDraft((state) => state.hydrateSettings);
  const zipPasswords = useNewDownloadDraft((state) => state.zipPasswords);
  const zipLoadingPaths = useNewDownloadDraft((state) => state.zipLoadingPaths);
  const renames = useNewDownloadDraft((state) => state.renames);
  const setZipPassword = useNewDownloadDraft((state) => state.setZipPassword);
  const setZipLoading = useNewDownloadDraft((state) => state.setZipLoading);
  const renameNode = useNewDownloadDraft((state) => state.renameNode);

  const [loading, setLoading] = React.useState(false);
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
  const urlInputRef = React.useRef<HTMLInputElement>(null);
  const passwordInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);

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

  const tryAutoCollectionPasswords = React.useCallback(
    async (trimmedUrl: string, shareId: string, seq: number) => {
      try {
        const settings = await window.api.invoke("setting:getMany", [
          "general.autoTryCollectionPasswords",
          "general.collectionPasswordList",
        ]);

        if (seq !== loadSeqRef.current) {
          return true;
        }

        if (!settings["general.autoTryCollectionPasswords"]) {
          return false;
        }

        const candidates = settings["general.collectionPasswordList"].filter(Boolean);
        if (candidates.length === 0) {
          return false;
        }

        const winner = await new Promise<{
          loaded: Awaited<ReturnType<typeof window.api.invoke<"download:loadCollection">>>;
          password: string;
        } | null>((resolve) => {
          let pending = candidates.length;
          let settled = false;

          for (const candidate of candidates) {
            void window.api
              .invoke("download:loadCollection", {
                url: trimmedUrl,
                password: candidate,
              })
              .then((loaded) => {
                if (settled) {
                  return;
                }
                settled = true;
                resolve({ loaded, password: candidate });
              })
              .catch(() => {
                pending -= 1;
                if (!settled && pending === 0) {
                  resolve(null);
                }
              });
          }
        });

        if (seq !== loadSeqRef.current) {
          return true;
        }

        if (!winner) {
          return false;
        }

        setPassword(winner.password);
        setCollection(winner.loaded);
        setSelected(collectAllPaths(winner.loaded.tree));
        setPasswordRequired(false);
        setPasswordInvalid(false);
        setProbedShareId(shareId);
        return true;
      } catch {
        return false;
      }
    },
    [
      setCollection,
      setPassword,
      setPasswordInvalid,
      setPasswordRequired,
      setProbedShareId,
      setSelected,
    ],
  );

  const loadCollection = React.useCallback(
    async (trimmedUrl: string, loadPassword?: string) => {
      const parsed = tryParseDownloadUrl(trimmedUrl);
      const extended = trimmedUrl.startsWith("KDE1.");
      if (!parsed && !extended) {
        return;
      }

      const seq = ++loadSeqRef.current;
      setLoading(true);
      setExtendedLoadProgress(extended ? { current: 0, total: 0 } : null);

      try {
        const loaded = await window.api.invoke("download:loadCollection", {
          url: trimmedUrl,
          password: loadPassword || undefined,
        });

        if (seq !== loadSeqRef.current) {
          return;
        }

        setCollection(loaded);
        setSelected(collectAllPaths(loaded.tree));
        setPasswordRequired(false);
        setPasswordInvalid(false);
        setProbedShareId(parsed?.id ?? trimmedUrl);
      } catch (error) {
        if (seq !== loadSeqRef.current) {
          return;
        }

        if (
          loadPassword &&
          (isCollectionInvalidPasswordError(error) || isExtendedShareInvalidPasswordError(error))
        ) {
          setPasswordInvalid(true);
          setCollection(null);
          setSelected(new Set());
          return;
        }

        if (
          !loadPassword &&
          (isCollectionPasswordRequiredError(error) || isExtendedSharePasswordRequiredError(error))
        ) {
          setProbedShareId(parsed?.id ?? trimmedUrl);
          setPasswordRequired(true);
          setCollection(null);
          setSelected(new Set());

          const autoTried = await tryAutoCollectionPasswords(
            trimmedUrl,
            parsed?.id ?? trimmedUrl,
            seq,
          );
          if (autoTried || seq !== loadSeqRef.current) {
            return;
          }

          requestAnimationFrame(() => passwordInputRef.current?.focus());
          return;
        }

        setPasswordRequired(null);
        setProbedShareId(null);
        setCollection(null);
        setSelected(new Set());
        toast.error("컬렉션을 불러오지 못했습니다", {
          description: getIpcErrorCause(error),
        });
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false);
          setExtendedLoadProgress(null);
        }
      }
    },
    [
      setCollection,
      setPasswordInvalid,
      setPasswordRequired,
      setProbedShareId,
      setSelected,
      tryAutoCollectionPasswords,
    ],
  );

  const verifyPassword = React.useCallback(() => {
    const trimmedUrl = url.trim();
    if (
      passwordRequired !== true ||
      !password.trim() ||
      (!tryParseDownloadUrl(trimmedUrl) && !trimmedUrl.startsWith("KDE1."))
    ) {
      return;
    }

    void loadCollection(trimmedUrl, password);
  }, [loadCollection, password, passwordRequired, url]);

  React.useEffect(() => {
    const trimmedUrl = url.trim();
    const parsed = tryParseDownloadUrl(trimmedUrl);
    const identity = parsed?.id ?? (trimmedUrl.startsWith("KDE1.") ? trimmedUrl : null);

    if (!identity) {
      loadSeqRef.current += 1;
      clearProbeState();
      setLoading(false);
      return;
    }

    if (identity === probedShareId || (parsed != null && parsed.id === collection?.shareId)) {
      return;
    }

    if (identity === probedShareId && passwordRequired === true) {
      return;
    }

    clearProbeState();
    void loadCollection(trimmedUrl);
  }, [clearProbeState, collection?.shareId, loadCollection, passwordRequired, probedShareId, url]);

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
      if (!collection) {
        return;
      }
      setZipLoading(zipPath, true);
      try {
        const result = await window.api.invoke("download:listZipEntries", {
          url: url.trim(),
          password: password || undefined,
          fileId,
          zipPassword,
        });
        if (zipPassword) {
          setZipPassword(fileId, zipPassword);
        }
        const nextTree = setZipEntries(collection.tree, fileId, result.entries);
        setCollection({ ...collection, tree: nextTree });
        updateSelected((prev) => selectExpandedZipEntries(prev, nextTree, zipPath, fileId));
        setZipPasswordPrompt(null);
        setZipPasswordInput("");
      } catch (error) {
        if (isZipPasswordRequiredError(error) || isZipInvalidPasswordError(error)) {
          setZipPasswordPrompt({
            path: zipPath,
            fileId,
            invalid: isZipInvalidPasswordError(error),
          });
          return;
        }
        toast.error("ZIP 목록을 불러오지 못했습니다", {
          description: getIpcErrorCause(error),
        });
      } finally {
        setZipLoading(zipPath, false);
      }
    },
    [collection, password, setCollection, setZipLoading, setZipPassword, updateSelected, url],
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

  const currentShareId =
    tryParseDownloadUrl(url.trim())?.id ?? (url.trim().startsWith("KDE1.") ? url.trim() : null);
  const collectionSynced =
    collection !== null &&
    (collection.provider === "extended"
      ? currentShareId === probedShareId
      : currentShareId === collection.shareId) &&
    !loading;
  const canStart =
    collectionSynced && summary.count > 0 && savePath.trim().length > 0 && passwordInvalid !== true;
  const effectiveSavePath =
    displayTree &&
    collection &&
    savePath.trim() &&
    shouldCreateCollectionSubfolder(displayTree, collection.name, createCollectionSubfolder)
      ? `${savePath.trim().replace(/[/\\]+$/, "")}/${collection.name}`
      : null;

  const handleStart = async () => {
    if (
      !collection ||
      !canStart ||
      (collection.provider === "extended"
        ? currentShareId !== probedShareId
        : currentShareId !== collection.shareId) ||
      loading
    ) {
      return;
    }
    setStarting(true);
    try {
      const created = await window.api.invoke("download:create", {
        url: url.trim(),
        password: password || undefined,
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
                    placeholder="https://kio.ac/c/... 또는 .kds 파일"
                    value={url}
                    onChange={(e) => {
                      const value = e.target.value;
                      setUrl(tryDecodeShareUrlBase64(value) ?? value);
                    }}
                    onPaste={(e) => {
                      const value = e.clipboardData.getData("text").trim();
                      const resolved = tryDecodeShareUrlBase64(value) ?? value;
                      if (!tryParseDownloadUrl(resolved) && !resolved.startsWith("KDE1.")) {
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
                        setPasswordInvalid(false);
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
                  <MetaRow icon={<HashIcon className="size-3" />} label="Share ID">
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
                  onExpandZip={collection.provider === "extended" ? undefined : handleExpandZip}
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
