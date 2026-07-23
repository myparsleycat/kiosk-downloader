import { FileTree } from "@renderer/components/tree/file-tree";
import { RenameDialog, type RenameTarget } from "@renderer/components/tree/rename-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import { Calendar } from "@renderer/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@renderer/components/ui/field";
import { Input } from "@renderer/components/ui/input";
import { InputGroup, InputGroupInput } from "@renderer/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Separator } from "@renderer/components/ui/separator";
import { cn } from "@renderer/lib/utils";
import { clampExpiry, mergeDateAndTime, useUploadDraft } from "@renderer/stores/upload-draft";
import { buildDirTreeFromFiles, validateDirTreeFilePaths } from "@shared/dir-tree";
import {
  createExtendedUploadPlan,
  EXTENDED_UPLOAD_DEFAULT_LIMITS,
} from "@shared/extended-upload-plan";
import { basename } from "@shared/tree-rename";
import type {
  ExpandPathsResult,
  UploadMode,
  UploadPlanProgress,
  UploadTreeFile,
} from "@shared/types";
import { formatSize } from "@shared/utils";
import { format, isSameDay } from "date-fns";
import { ko } from "date-fns/locale";
import {
  ChevronDownIcon,
  EyeIcon,
  EyeOffIcon,
  FileUpIcon,
  FolderIcon,
  FolderOpenIcon,
  Loader2Icon,
  LockIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Textarea } from "../ui/textarea";

const MAX_NAME = 100;
const MAX_DESCRIPTION = 2500;
const MAX_PASSWORD = 100;
const MAX_EXPIRY_DAYS = 30;
const MAX_UPLOAD_BYTES = EXTENDED_UPLOAD_DEFAULT_LIMITS.maxBytes;
const MAX_UPLOAD_FILES = EXTENDED_UPLOAD_DEFAULT_LIMITS.maxFiles;

function mergeUploadFiles(
  existing: UploadTreeFile[],
  incoming: UploadTreeFile[],
): UploadTreeFile[] {
  const merged = new Map(existing.map((file) => [file.path, file]));
  for (const file of incoming) {
    merged.set(file.path, file);
  }
  return [...merged.values()];
}

function newIncomingPaths(existing: UploadTreeFile[], incoming: UploadTreeFile[]): string[] {
  const existingPaths = new Set(existing.map((file) => file.path));
  return incoming.filter((file) => !existingPaths.has(file.path)).map((file) => file.path);
}

function removeDraftSources(paths: string[]) {
  if (paths.length === 0) return;
  void window.api.invoke("upload:removeDraftSources", paths);
}

export function UploadView({ onCreated }: { onCreated: (uploadId: string) => void }) {
  const files = useUploadDraft((s) => s.files);
  const name = useUploadDraft((s) => s.name);
  const description = useUploadDraft((s) => s.description);
  const password = useUploadDraft((s) => s.password);
  const expiresAt = useUploadDraft((s) => s.expiresAt);
  const mode = useUploadDraft((s) => s.mode);
  const addFiles = useUploadDraft((s) => s.addFiles);
  const removeFile = useUploadDraft((s) => s.removeFile);
  const renameFile = useUploadDraft((s) => s.renameFile);
  const clearFiles = useUploadDraft((s) => s.clearFiles);
  const setName = useUploadDraft((s) => s.setName);
  const setDescription = useUploadDraft((s) => s.setDescription);
  const setPassword = useUploadDraft((s) => s.setPassword);
  const setExpiresAt = useUploadDraft((s) => s.setExpiresAt);
  const setMode = useUploadDraft((s) => s.setMode);
  const resetDraft = useUploadDraft((s) => s.resetDraft);

  const [expanding, setExpanding] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(true);
  const [dragOver, setDragOver] = React.useState(false);
  const [expiryOpen, setExpiryOpen] = React.useState(false);
  const [modeDialogOpen, setModeDialogOpen] = React.useState(false);
  const [modeChoice, setModeChoice] = React.useState<Exclude<UploadMode, "standard"> | null>(null);
  const [modeDialogSummary, setModeDialogSummary] = React.useState({
    files: 0,
    bytes: 0,
    compatibleCollections: 0,
  });
  const [oversizeDialogOpen, setOversizeDialogOpen] = React.useState(false);
  const [renameTarget, setRenameTarget] = React.useState<RenameTarget | null>(null);
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const renameTargetRef = React.useRef(renameTarget);
  renameTargetRef.current = renameTarget;
  const modeResolverRef = React.useRef<
    ((choice: Exclude<UploadMode, "standard"> | null) => void) | null
  >(null);
  const oversizeResolverRef = React.useRef<
    ((choice: "integrated" | "exclude" | "cancel") => void) | null
  >(null);

  const expiryDate = new Date(expiresAt);
  const expiryTime = format(expiryDate, "HH:mm:ss");

  const minExpiryMonth = new Date(new Date().setDate(1));
  const maxExpiryDate = new Date();
  maxExpiryDate.setDate(maxExpiryDate.getDate() + MAX_EXPIRY_DAYS);
  const maxExpiryMonth = new Date(maxExpiryDate.getFullYear(), maxExpiryDate.getMonth(), 1);

  const handleExpiryDateSelect = (date: Date | undefined) => {
    if (!date) return;
    setExpiresAt(mergeDateAndTime(date, expiryTime));
    setExpiryOpen(false);
  };

  const handleExpiryTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setExpiresAt(mergeDateAndTime(expiryDate, e.target.value || "00:00:00"));
  };

  const tree = React.useMemo(() => buildDirTreeFromFiles(files), [files]);
  const totalFiles = files.length;
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const extendedRequired = totalFiles > MAX_UPLOAD_FILES || totalBytes > MAX_UPLOAD_BYTES;
  const plannedCollections = React.useMemo(() => {
    // integrated 모드는 content hash 기반 packing 후에야 collection 수가 확정되므로
    // 업로드 전 계획값을 표시하지 않는다. compatible만 정확값을 사용한다.
    if (!extendedRequired || mode !== "compatible") return 1;
    const planned = createExtendedUploadPlan(files, mode);
    return planned.ok ? planned.collections.length : 0;
  }, [extendedRequired, files, mode]);

  React.useEffect(() => {
    if (!extendedRequired && mode !== "standard") setMode("standard");
  }, [extendedRequired, mode, setMode]);

  const canUpload = totalFiles > 0 && name.trim().length > 0 && !starting;

  const askMode = (nextFiles: UploadTreeFile[]) => {
    const compatible = createExtendedUploadPlan(nextFiles, "compatible");
    setModeDialogSummary({
      files: nextFiles.length,
      bytes: nextFiles.reduce((sum, file) => sum + file.size, 0),
      compatibleCollections: compatible.ok ? compatible.collections.length : 0,
    });
    setModeChoice(null);
    setModeDialogOpen(true);
    return new Promise<Exclude<UploadMode, "standard"> | null>((resolve) => {
      modeResolverRef.current = resolve;
    });
  };

  const resolveMode = (choice: Exclude<UploadMode, "standard"> | null) => {
    const resolve = modeResolverRef.current;
    if (!resolve) return;
    modeResolverRef.current = null;
    setModeDialogOpen(false);
    resolve(choice);
  };

  const askOversize = () => {
    setOversizeDialogOpen(true);
    return new Promise<"integrated" | "exclude" | "cancel">((resolve) => {
      oversizeResolverRef.current = resolve;
    });
  };

  const resolveOversize = (choice: "integrated" | "exclude" | "cancel") => {
    const resolve = oversizeResolverRef.current;
    if (!resolve) return;
    oversizeResolverRef.current = null;
    setOversizeDialogOpen(false);
    resolve(choice);
  };

  const handleAddExpanded = async (load: () => Promise<ExpandPathsResult>) => {
    setExpanding(true);
    // Let the loading spinner paint before the heavy IPC / store update.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let incomingPaths: string[] = [];
    try {
      const result = await load();
      if (result.files.length === 0) return;

      incomingPaths = newIncomingPaths(files, result.files);
      const merged = mergeUploadFiles(files, result.files);
      validateDirTreeFilePaths(merged);
      const mergedBytes = merged.reduce((sum, file) => sum + file.size, 0);
      const requiresExtended = merged.length > MAX_UPLOAD_FILES || mergedBytes > MAX_UPLOAD_BYTES;
      let nextMode = mode;
      if (requiresExtended && nextMode === "standard") {
        setExpanding(false);
        const choice = await askMode(merged);
        if (!choice) {
          removeDraftSources(incomingPaths);
          return;
        }
        nextMode = choice;
      }

      let accepted = result.files;
      if (nextMode === "compatible" && merged.some((file) => file.size > MAX_UPLOAD_BYTES)) {
        setExpanding(false);
        const choice = await askOversize();
        if (choice === "cancel") {
          removeDraftSources(incomingPaths);
          return;
        }
        if (choice === "integrated") nextMode = "integrated";
        else accepted = result.files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
      }

      setMode(nextMode);
      addFiles(accepted);
    } catch (error) {
      removeDraftSources(incomingPaths);
      toast.error("파일을 불러오지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setExpanding(false);
    }
  };

  const handleFilePicker = () => {
    void handleAddExpanded(() => window.api.invoke("upload:pickFiles"));
  };

  const handleFolderPicker = () => {
    void handleAddExpanded(() => window.api.invoke("upload:pickFolder"));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // Must read DataTransfer synchronously — it is invalidated after this handler returns.
    const dropped = collectDroppedFiles(e.dataTransfer);
    if (dropped.length === 0) return;
    void handleAddExpanded(() => window.api.expandDroppedFiles(dropped));
  };

  const handleModeChange = async () => {
    const choice = await askMode(files);
    if (!choice) return;
    if (choice === "compatible" && files.some((file) => file.size > MAX_UPLOAD_BYTES)) {
      const oversizeChoice = await askOversize();
      if (oversizeChoice === "cancel") return;
      if (oversizeChoice === "integrated") {
        setMode("integrated");
        return;
      }
      for (const file of files.filter((candidate) => candidate.size > MAX_UPLOAD_BYTES)) {
        removeFile(file.path);
      }
    }
    setMode(choice);
  };

  const handleStart = async () => {
    if (!canUpload) return;
    setStarting(true);
    try {
      const created = await window.api.invoke("upload:create", {
        tree: files,
        options: {
          name: name.trim().slice(0, MAX_NAME),
          description: description.slice(0, MAX_DESCRIPTION),
          password: password || "",
          expires: expiresAt,
        },
        mode,
      });

      if (!created) {
        throw new Error("업로드를 만들지 못했습니다.");
      }

      if (created.phase === "initializing" && created.status === "paused") {
        toast.warning("확장 업로드 초기화가 중단되었습니다", {
          description: created.error
            ? `${created.error} 업로드 목록에서 시작을 눌러 다시 시도할 수 있습니다.`
            : "업로드 목록에서 시작을 눌러 남은 초기화를 이어갈 수 있습니다.",
        });
      } else {
        toast.success("업로드가 시작되었습니다", {
          description: `${name.trim()} · ${files.length}개 파일`,
        });
      }
      resetDraft();
      onCreated(created.id);
    } catch (error) {
      toast.error("업로드를 시작하지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex h-full">
      <Dialog
        open={modeDialogOpen}
        onOpenChange={(open) => {
          if (!open) resolveMode(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>확장 업로드 사용</DialogTitle>
            <DialogDescription>
              {modeDialogSummary.files}개 · {formatSize(modeDialogSummary.bytes)}를 업로드하려면
              여러 컬렉션이 필요합니다.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <button
              type="button"
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                modeChoice === "integrated" ? "border-primary bg-primary/5" : "hover:bg-muted/50",
              )}
              onClick={() => setModeChoice("integrated")}
            >
              <span className="block text-sm font-medium">통합 공유</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Kiosk Downloader 전용 · 대형 파일 자동 재조립 · 공유 정보 1개
              </span>
              <span className="mt-2 block text-xs tabular-nums">
                파일 분석 후 컬렉션 수와 보안 인증 횟수가 결정됩니다
              </span>
            </button>
            <button
              type="button"
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                modeChoice === "compatible" ? "border-primary bg-primary/5" : "hover:bg-muted/50",
              )}
              onClick={() => setModeChoice("compatible")}
            >
              <span className="block text-sm font-medium">호환 공유</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                웹 다운로드 지원 · 표준 Kiosk 링크 여러 개
              </span>
              <span className="mt-2 block text-xs tabular-nums">
                {modeDialogSummary.compatibleCollections > 0
                  ? `${modeDialogSummary.compatibleCollections}개 컬렉션 · 같은 횟수의 보안 인증`
                  : "50 GiB 초과 파일을 먼저 처리해야 합니다"}
              </span>
            </button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => resolveMode(null)}>
              취소
            </Button>
            <Button disabled={!modeChoice} onClick={() => modeChoice && resolveMode(modeChoice)}>
              계속
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={oversizeDialogOpen}
        onOpenChange={(open) => {
          if (open) return;
          resolveOversize("cancel");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>호환 공유에서 지원하지 않는 대형 파일</AlertDialogTitle>
            <AlertDialogDescription>
              50 GiB를 초과한 파일은 표준 Kiosk에서 다운로드할 수 없습니다. 통합 공유로 전환하거나
              해당 파일을 제외하세요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-wrap sm:justify-end">
            <AlertDialogCancel onClick={() => resolveOversize("cancel")}>취소</AlertDialogCancel>
            <Button variant="outline" onClick={() => resolveOversize("exclude")}>
              파일 제외하고 계속
            </Button>
            <AlertDialogAction onClick={() => resolveOversize("integrated")}>
              통합 공유로 전환
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex w-[340px] min-w-0 shrink-0 flex-col overflow-hidden border-r">
        <div className="border-b px-4 py-3">
          <h2 className="cn-font-heading text-sm font-medium">컬렉션 정보</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            만료일, 제목, 비밀번호를 설정하세요
          </p>
        </div>

        <ScrollArea className="flex-1">
          <div className="flex w-full min-w-0 flex-col gap-4 p-4">
            <Field>
              <FieldLabel htmlFor="upload-name">
                <FolderIcon className="size-3" />
                제목
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="upload-name"
                  placeholder="컬렉션 제목"
                  value={name}
                  maxLength={MAX_NAME}
                  onChange={(e) => setName(e.target.value)}
                />
              </InputGroup>
              <FieldDescription className="text-xs">
                {name.length}/{MAX_NAME}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="upload-description">설명 (선택)</FieldLabel>
              <Textarea
                id="upload-description"
                placeholder="컬렉션에 대한 설명"
                value={description}
                maxLength={MAX_DESCRIPTION}
                rows={3}
                onChange={(e) => setDescription(e.target.value)}
              />
              <FieldDescription className="text-xs">
                {description.length}/{MAX_DESCRIPTION}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel>만료일</FieldLabel>
              <div className="flex gap-2">
                <Popover open={expiryOpen} onOpenChange={setExpiryOpen}>
                  <PopoverTrigger
                    render={
                      <Button variant="outline" className="flex-1 justify-between font-normal">
                        {format(expiryDate, "PPP", { locale: ko })}
                        <ChevronDownIcon className="size-4 opacity-50" />
                      </Button>
                    }
                  />
                  <PopoverContent className="w-auto overflow-hidden p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={expiryDate}
                      locale={ko}
                      startMonth={minExpiryMonth}
                      endMonth={maxExpiryMonth}
                      defaultMonth={expiryDate}
                      disabled={(date) =>
                        date < new Date(new Date().setHours(0, 0, 0, 0)) || date > maxExpiryDate
                      }
                      onSelect={handleExpiryDateSelect}
                    />
                  </PopoverContent>
                </Popover>
                <Input
                  type="time"
                  step="1"
                  value={expiryTime}
                  onChange={handleExpiryTimeChange}
                  className="w-30 appearance-none bg-background [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                />
              </div>

              <div className="flex gap-1.5">
                {[1, 7, 30].map((days) => {
                  const target = clampExpiry(Date.now() + days * 24 * 60 * 60 * 1000);
                  const active = isSameDay(expiryDate, new Date(target));
                  return (
                    <Button
                      key={days}
                      variant={active ? "default" : "outline"}
                      size="xs"
                      className="flex-1"
                      onClick={() => setExpiresAt(target)}
                    >
                      {days}일
                    </Button>
                  );
                })}
              </div>
            </Field>

            <Field>
              <FieldLabel htmlFor="upload-password">
                <LockIcon className="size-3" />
                비밀번호 (선택)
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="upload-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="비밀번호"
                  value={password}
                  maxLength={MAX_PASSWORD}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="flex shrink-0 items-center px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 표시"}
                >
                  {showPassword ? (
                    <EyeOffIcon className="size-3.5" />
                  ) : (
                    <EyeIcon className="size-3.5" />
                  )}
                </button>
              </InputGroup>
            </Field>

            <Separator />

            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">파일</span>
                <span className="font-medium tabular-nums">
                  {totalFiles}개 · {formatSize(totalBytes)}
                </span>
              </div>
            </div>

            {extendedRequired && mode !== "standard" && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      확장 업로드 · {mode === "integrated" ? "통합 공유" : "호환 공유"}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {mode === "integrated"
                        ? "파일 분석 후 컬렉션 수와 보안 인증 횟수가 결정됩니다"
                        : `예상 ${plannedCollections}개 컬렉션 · ${plannedCollections}회의 보안 인증`}
                    </div>
                  </div>
                  <Button size="xs" variant="ghost" onClick={() => void handleModeChange()}>
                    모드 변경
                  </Button>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <UploadStartFooter
          mode={mode}
          starting={starting}
          disabled={!canUpload}
          onStart={handleStart}
        />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="cn-font-heading text-sm font-medium">업로드 파일</span>
          <div className="flex items-center gap-1.5">
            <Button size="xs" variant="outline" onClick={handleFilePicker} disabled={expanding}>
              <FileUpIcon className="size-3" />
              파일 선택
            </Button>
            <Button size="xs" variant="outline" onClick={handleFolderPicker} disabled={expanding}>
              <FolderOpenIcon className="size-3" />
              폴더 선택
            </Button>
            {files.length > 0 && (
              <Button size="xs" variant="ghost" onClick={clearFiles} disabled={expanding}>
                <Trash2Icon className="size-3" />
                전체 삭제
              </Button>
            )}
          </div>
        </div>

        {files.length === 0 ? (
          <DropZone
            dragOver={dragOver}
            expanding={expanding}
            onDrop={handleDrop}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onFilePicker={handleFilePicker}
            onFolderPicker={handleFolderPicker}
          />
        ) : (
          <>
            <div className="flex items-center justify-between border-b px-4 py-1.5 text-xs text-muted-foreground">
              <span>
                <span className="tabular-nums">{totalFiles}</span> 파일
              </span>
              <span className="tabular-nums">{formatSize(totalBytes)}</span>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2">
                <FileTree
                  mode="selection"
                  root={tree}
                  onDelete={(key) => removeFile(key)}
                  onRename={(key, kind) => {
                    setRenameError(null);
                    setRenameTarget({ path: key, name: basename(key), kind });
                  }}
                />
              </div>
            </ScrollArea>
          </>
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
          if (!renameTarget) {
            return;
          }
          const submittedPath = renameTarget.path;
          void (async () => {
            const error = await renameFile(submittedPath, nextName);
            if (renameTargetRef.current?.path !== submittedPath) {
              return;
            }
            if (error) {
              setRenameError(error);
              return;
            }
            setRenameTarget(null);
            setRenameError(null);
          })();
        }}
      />
    </div>
  );
}

function collectDroppedFiles(dataTransfer: DataTransfer): File[] {
  const items = dataTransfer.items;
  if (!items || items.length === 0) return [];

  // Top-level items only — never fall back to dataTransfer.files, which Chromium
  // may expand to every nested file in a dropped folder (1000+).
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function DropZone({
  dragOver,
  expanding,
  onDrop,
  onDragOver,
  onDragLeave,
  onFilePicker,
  onFolderPicker,
}: {
  dragOver: boolean;
  expanding: boolean;
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onFilePicker: () => void;
  onFolderPicker: () => void;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-4 p-8 text-center transition-colors",
        dragOver ? "bg-primary/5" : "",
      )}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {expanding ? (
        <Loader2Icon className="size-10 animate-spin text-muted-foreground" />
      ) : (
        <UploadIcon className="size-10 text-muted-foreground/40" />
      )}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">
          {expanding ? "파일을 불러오는 중..." : "파일을 드래그하여 추가하세요"}
        </span>
        <span className="text-xs text-muted-foreground">
          파일 및 폴더를 여기로 드래그 앤 드롭하거나 아래 버튼으로 선택
        </span>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onFilePicker} disabled={expanding}>
          <FileUpIcon className="size-3.5" />
          파일 선택
        </Button>
        <Button size="sm" variant="outline" onClick={onFolderPicker} disabled={expanding}>
          <FolderOpenIcon className="size-3.5" />
          폴더 선택
        </Button>
      </div>
    </div>
  );
}

function formatPlanProgressLabel(progress: UploadPlanProgress) {
  if (progress.stage === "hashing") {
    if (progress.total <= 0) return "파일 분석 중...";
    return `파일 분석 중... ${progress.current}/${progress.total}`;
  }
  return "업로드 계획 중...";
}

const UploadStartFooter = React.memo(function UploadStartFooter({
  mode,
  starting,
  disabled,
  onStart,
}: {
  mode: UploadMode;
  starting: boolean;
  disabled: boolean;
  onStart: () => void;
}) {
  const [progress, setProgress] = React.useState<UploadPlanProgress | null>(null);

  React.useEffect(() => {
    if (!starting) {
      setProgress(null);
      return;
    }
    return window.api.on("upload:plan-progress", setProgress);
  }, [starting]);

  return (
    <div className="border-t p-3">
      <Button className="w-full" disabled={disabled} isLoading={starting} onClick={onStart}>
        <UploadIcon className="size-3.5" />
        {starting && progress
          ? formatPlanProgressLabel(progress)
          : mode === "integrated"
            ? "업로드 & 공유 정보 생성"
            : "업로드 & 링크 생성"}
      </Button>
      {starting && progress ? (
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
          {progress.stage === "hashing"
            ? `파일 해시 계산 ${progress.current}/${progress.total}`
            : "작은 파일 묶음 계획 중"}
        </p>
      ) : null}
    </div>
  );
});
