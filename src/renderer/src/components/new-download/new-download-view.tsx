import { FileTree } from "@renderer/components/tree/file-tree";
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
  isCollectionInvalidPasswordError,
  isCollectionPasswordRequiredError,
  isZipInvalidPasswordError,
  isZipPasswordRequiredError,
} from "@shared/download-errors";
import { tryDecodeShareUrlBase64, tryParseShareUrl } from "@shared/share-url";
import { formatSize } from "@shared/utils";
import { setZipEntries } from "@shared/zip-tree";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ClockIcon,
  DownloadIcon,
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
  const setZipPassword = useNewDownloadDraft((state) => state.setZipPassword);
  const setZipLoading = useNewDownloadDraft((state) => state.setZipLoading);

  const [loading, setLoading] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [sortField, setSortField] = React.useState<SortField>("name");
  const [sortDir, setSortDir] = React.useState<SortDir>("none");
  const [zipPasswordPrompt, setZipPasswordPrompt] = React.useState<{
    path: string;
    fileId: string;
    invalid: boolean;
  } | null>(null);
  const [zipPasswordInput, setZipPasswordInput] = React.useState("");

  const loadSeqRef = React.useRef(0);
  const urlInputRef = React.useRef<HTMLInputElement>(null);
  const passwordInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);

  React.useEffect(() => {
    requestAnimationFrame(() => urlInputRef.current?.focus());
  }, []);

  const loadCollection = React.useCallback(
    async (trimmedUrl: string, loadPassword?: string) => {
      const shareId = tryParseShareUrl(trimmedUrl);
      if (!shareId) {
        return;
      }

      const seq = ++loadSeqRef.current;
      setLoading(true);

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
        setProbedShareId(shareId);
      } catch (error) {
        if (seq !== loadSeqRef.current) {
          return;
        }

        if (loadPassword && isCollectionInvalidPasswordError(error)) {
          setPasswordInvalid(true);
          setCollection(null);
          setSelected(new Set());
          return;
        }

        if (!loadPassword && isCollectionPasswordRequiredError(error)) {
          setPasswordRequired(true);
          setProbedShareId(shareId);
          setCollection(null);
          setSelected(new Set());
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
        }
      }
    },
    [setCollection, setPasswordInvalid, setPasswordRequired, setProbedShareId, setSelected],
  );

  const verifyPassword = React.useCallback(() => {
    const trimmedUrl = url.trim();
    if (passwordRequired !== true || !password.trim() || !tryParseShareUrl(trimmedUrl)) {
      return;
    }

    void loadCollection(trimmedUrl, password);
  }, [loadCollection, password, passwordRequired, url]);

  React.useEffect(() => {
    const trimmedUrl = url.trim();
    const shareId = tryParseShareUrl(trimmedUrl);

    if (!shareId) {
      loadSeqRef.current += 1;
      clearProbeState();
      setLoading(false);
      return;
    }

    if (shareId === collection?.shareId) {
      return;
    }

    if (shareId === probedShareId && passwordRequired === true) {
      return;
    }

    clearProbeState();
    void loadCollection(trimmedUrl);
  }, [clearProbeState, collection?.shareId, loadCollection, passwordRequired, probedShareId, url]);

  const handleToggle = (key: string) => {
    if (!collection) return;
    updateSelected((prev) => toggleTreeSelection(prev, key, collection.tree));
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
        setCollection({
          ...collection,
          tree: setZipEntries(collection.tree, fileId, result.entries),
        });
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
    [collection, password, setCollection, setZipLoading, setZipPassword, url],
  );

  const handleExpandZip = (zipPath: string, fileId: string) => {
    void expandZip(zipPath, fileId, zipPasswords[fileId]);
  };

  const summary = collection
    ? summarizeSelection(selected, collection.tree)
    : { count: 0, bytes: 0 };
  const totalFiles = collection ? countFiles(collection.tree) : 0;
  const totalBytes = collection ? dirTotalSize(collection.tree) : 0;

  const sortedTree = React.useMemo(
    () =>
      collection
        ? sortDir !== "none"
          ? sortTree(collection.tree, sortField, sortDir)
          : collection.tree
        : undefined,
    [collection, sortField, sortDir],
  );

  const handleSortClick = (field: SortField) => {
    if (field === sortField) {
      setSortDir((prev) => (prev === "none" ? "desc" : prev === "desc" ? "asc" : "none"));
      return;
    }
    setSortField(field);
    setSortDir("desc");
  };

  const currentShareId = tryParseShareUrl(url.trim());
  const collectionSynced = collection !== null && currentShareId === collection.shareId && !loading;
  const canStart =
    collectionSynced && summary.count > 0 && savePath.trim().length > 0 && passwordInvalid !== true;
  const effectiveSavePath =
    collection &&
    savePath.trim() &&
    shouldCreateCollectionSubfolder(collection.tree, collection.name, createCollectionSubfolder)
      ? `${savePath.trim().replace(/[/\\]+$/, "")}/${collection.name}`
      : null;

  const handleStart = async () => {
    if (
      !collection ||
      !canStart ||
      tryParseShareUrl(url.trim()) !== collection.shareId ||
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
      {/* left: input url + meta */}
      <div className="flex w-[320px] min-w-0 shrink-0 flex-col overflow-hidden border-r">
        <div className="border-b px-4 py-3">
          <h2 className="cn-font-heading text-sm font-medium">새 다운로드</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">kio.ac 공유 링크를 입력하세요</p>
        </div>

        <ScrollArea className="flex-1">
          <div className="flex w-full min-w-0 flex-col gap-4 p-4">
            {/* URL */}
            <div className="flex flex-col gap-1.5">
              <Field>
                <FieldLabel htmlFor="url-input">
                  <LinkIcon className="size-3" />
                  공유 URL
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    ref={urlInputRef}
                    id="url-input"
                    placeholder="https://kio.ac/c/..."
                    value={url}
                    onChange={(e) => {
                      const value = e.target.value;
                      setUrl(tryDecodeShareUrlBase64(value) ?? value);
                    }}
                  />
                  <InputGroupAddon align="inline-end">
                    {loading && <Loader2Icon className="size-4 animate-spin" />}
                  </InputGroupAddon>
                </InputGroup>
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

            {/* collection meta */}
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
                    {new Date(collection.expires * 1000).toLocaleString("ko-KR")}
                  </MetaRow>
                  <MetaRow icon={<HardDriveIcon className="size-3" />} label="총 파일">
                    {totalFiles}개 · {formatSize(totalBytes)}
                  </MetaRow>
                </div>
              </>
            )}
          </div>
        </ScrollArea>

        {/* bottom: save path + selected summary + start button */}
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

      {/* right: tree browser */}
      <div className="flex flex-1 flex-col">
        {collection ? (
          <>
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <span className="cn-font-heading text-sm font-medium">파일 선택</span>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
                  root={sortedTree ?? collection.tree}
                  selected={selected}
                  onToggle={handleToggle}
                  onExpandZip={handleExpandZip}
                  zipLoadingPaths={zipLoadingPaths}
                />
              </div>
            </ScrollArea>
          </>
        ) : (
          <EmptyState loading={loading} />
        )}
      </div>

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
        {loading ? "컬렉션을 불러오는 중..." : "좌측에서 URL을 입력해 컬렉션을 불러오세요"}
      </span>
    </div>
  );
}
