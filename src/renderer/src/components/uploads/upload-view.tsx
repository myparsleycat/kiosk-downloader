import { FileTree } from "@renderer/components/tree/file-tree";
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
import { Field, FieldDescription, FieldLabel } from "@renderer/components/ui/field";
import { Input } from "@renderer/components/ui/input";
import { InputGroup, InputGroupInput } from "@renderer/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Separator } from "@renderer/components/ui/separator";
import { cn } from "@renderer/lib/utils";
import { clampExpiry, useUploadDraft } from "@renderer/stores/upload-draft";
import { buildDirTreeFromFiles } from "@shared/dir-tree";
import type { ExpandPathsResult, UploadTreeFile } from "@shared/types";
import { MAX_UPLOAD_FILES } from "@shared/types";
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
const MAX_UPLOAD_BYTES = 50 * 1024 ** 3;

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
  const addFiles = useUploadDraft((s) => s.addFiles);
  const removeFile = useUploadDraft((s) => s.removeFile);
  const clearFiles = useUploadDraft((s) => s.clearFiles);
  const renameFile = useUploadDraft((s) => s.renameFile);
  const setName = useUploadDraft((s) => s.setName);
  const setDescription = useUploadDraft((s) => s.setDescription);
  const setPassword = useUploadDraft((s) => s.setPassword);
  const setExpiresAt = useUploadDraft((s) => s.setExpiresAt);
  const resetDraft = useUploadDraft((s) => s.resetDraft);

  const [expanding, setExpanding] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(true);
  const [dragOver, setDragOver] = React.useState(false);
  const [expiryOpen, setExpiryOpen] = React.useState(false);
  const [countOverflowOpen, setCountOverflowOpen] = React.useState(false);
  const countOverflowResolverRef = React.useRef<((confirmed: boolean) => void) | null>(null);

  const expiryDate = new Date(expiresAt);
  const expiryTime = format(expiryDate, "HH:mm:ss");

  const minExpiryMonth = new Date(new Date().setDate(1));
  const maxExpiryDate = new Date();
  maxExpiryDate.setDate(maxExpiryDate.getDate() + MAX_EXPIRY_DAYS);
  const maxExpiryMonth = new Date(maxExpiryDate.getFullYear(), maxExpiryDate.getMonth(), 1);

  const mergeDateAndTime = (date: Date, time: string): number => {
    const [h, m, s] = time.split(":").map((n) => {
      const v = Number(n);
      return Number.isNaN(v) ? 0 : v;
    });
    const merged = new Date(date);
    merged.setHours(h, m, s, 0);
    return clampExpiry(merged.getTime());
  };

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

  const canUpload = totalFiles > 0 && name.trim().length > 0 && !starting;

  const askCountOverflow = () => {
    setCountOverflowOpen(true);
    return new Promise<boolean>((resolve) => {
      countOverflowResolverRef.current = resolve;
    });
  };

  const resolveCountOverflow = (confirmed: boolean) => {
    const resolve = countOverflowResolverRef.current;
    if (!resolve) return;
    countOverflowResolverRef.current = null;
    setCountOverflowOpen(false);
    resolve(confirmed);
  };

  const handleAddExpanded = async (load: (maxFiles: number) => Promise<ExpandPathsResult>) => {
    setExpanding(true);
    // Let the loading spinner paint before the heavy IPC / store update.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const remainingSlots = Math.max(0, MAX_UPLOAD_FILES - files.length);
      if (remainingSlots === 0) {
        toast.warning("하나의 컬렉션엔 최대 1000개의 파일만 추가 할 수 있습니다");
        return;
      }

      const result = await load(remainingSlots);
      if (result.files.length === 0) return;

      const merged = mergeUploadFiles(files, result.files);
      const mergedBytes = merged.reduce((sum, file) => sum + file.size, 0);
      if (mergedBytes > MAX_UPLOAD_BYTES) {
        toast.warning("최대 50 GiB 까지만 추가할 수 있습니다");
        removeDraftSources(newIncomingPaths(files, result.files));
        return;
      }

      if (result.truncated) {
        setExpanding(false);
        const confirmed = await askCountOverflow();
        if (!confirmed) {
          removeDraftSources(newIncomingPaths(files, result.files));
          return;
        }
      }

      addFiles(result.files);
    } catch (error) {
      toast.error("파일을 불러오지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setExpanding(false);
    }
  };

  const handleFilePicker = () => {
    void handleAddExpanded((maxFiles) => window.api.invoke("upload:pickFiles", maxFiles));
  };

  const handleFolderPicker = () => {
    void handleAddExpanded((maxFiles) => window.api.invoke("upload:pickFolder", maxFiles));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // Must read DataTransfer synchronously — it is invalidated after this handler returns.
    const dropped = collectDroppedFiles(e.dataTransfer);
    if (dropped.length === 0) return;
    void handleAddExpanded((maxFiles) => window.api.expandDroppedFiles(dropped, maxFiles));
  };

  const handleStart = async () => {
    if (!canUpload) return;
    setStarting(true);
    try {
      const turnstileToken = await window.api.invoke("upload:solveTurnstile");

      const created = await window.api.invoke("upload:create", {
        tree: files,
        options: {
          name: name.trim().slice(0, MAX_NAME),
          description: description.slice(0, MAX_DESCRIPTION),
          password: password || "",
          expires: expiresAt,
        },
        turnstileToken,
      });

      if (!created) {
        throw new Error("업로드를 만들지 못했습니다.");
      }

      toast.success("업로드가 시작되었습니다", {
        description: `${name.trim()} · ${files.length}개 파일`,
      });
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
      <AlertDialog
        open={countOverflowOpen}
        onOpenChange={(open) => {
          if (open) return;
          resolveCountOverflow(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>파일 개수 제한</AlertDialogTitle>
            <AlertDialogDescription>
              하나의 컬렉션엔 최대 1000개의 파일만 추가 할 수 있습니다. 초과분은 제외됩니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => resolveCountOverflow(false)}>취소</AlertDialogCancel>
            <AlertDialogAction onClick={() => resolveCountOverflow(true)}>확인</AlertDialogAction>
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
          </div>
        </ScrollArea>

        <div className="border-t p-3">
          <Button
            className="w-full"
            disabled={!canUpload}
            isLoading={starting}
            onClick={handleStart}
          >
            <UploadIcon className="size-3.5" />
            업로드 & 링크 생성
          </Button>
        </div>
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
                  onRename={(oldPath, newName) => {
                    const error = renameFile(oldPath, newName);
                    if (error) toast.error(error);
                  }}
                />
              </div>
            </ScrollArea>
          </>
        )}
      </div>
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
