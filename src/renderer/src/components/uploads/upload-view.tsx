import { FileTree } from "@renderer/components/tree/file-tree";
import { Button } from "@renderer/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@renderer/components/ui/field";
import { InputGroup, InputGroupInput } from "@renderer/components/ui/input-group";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Separator } from "@renderer/components/ui/separator";
import { summarizeSelection, toggleTreeSelection } from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import { resolveExpiryTimestamp, useUploadDraft } from "@renderer/stores/upload-draft";
import type { ExpiryPreset } from "@renderer/stores/upload-draft";
import type { DirNode, UploadTreeFile } from "@shared/types";
import { formatSize } from "@shared/utils";
import {
  EyeIcon,
  EyeOffIcon,
  FileUpIcon,
  FolderIcon,
  FolderOpenIcon,
  Loader2Icon,
  LockIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Textarea } from "../ui/textarea";

const MAX_NAME = 100;
const MAX_DESCRIPTION = 2500;
const MAX_PASSWORD = 100;

function buildTreeFromFiles(files: UploadTreeFile[]): DirNode {
  const root: DirNode = { type: "dir", id: "root", name: "", entries: [] };

  type MutableDir = DirNode;
  const dirsByPath = new Map<string, MutableDir>();
  dirsByPath.set("", root);

  const ensureDir = (segments: string[]): MutableDir => {
    const dirPath = segments.join("/");
    const existing = dirsByPath.get(dirPath);
    if (existing) return existing;

    const parent = ensureDir(segments.slice(0, -1));
    const dir: MutableDir = {
      type: "dir",
      id: dirPath,
      name: segments[segments.length - 1],
      entries: [],
    };
    dirsByPath.set(dirPath, dir);
    parent.entries.push({ kind: "dir", node: dir });
    return dir;
  };

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    const dir = ensureDir(segments.slice(0, -1));
    dir.entries.push({
      kind: "file",
      node: {
        type: "file",
        id: file.path,
        name: segments[segments.length - 1] ?? file.name,
        size: file.size,
      },
    });
  }

  return root;
}

export function UploadView({ onCreated }: { onCreated: (uploadId: string) => void }) {
  const files = useUploadDraft((s) => s.files);
  const name = useUploadDraft((s) => s.name);
  const description = useUploadDraft((s) => s.description);
  const password = useUploadDraft((s) => s.password);
  const expiryPreset = useUploadDraft((s) => s.expiryPreset);
  const selected = useUploadDraft((s) => s.selected);
  const addFiles = useUploadDraft((s) => s.addFiles);
  const clearFiles = useUploadDraft((s) => s.clearFiles);
  const setName = useUploadDraft((s) => s.setName);
  const setDescription = useUploadDraft((s) => s.setDescription);
  const setPassword = useUploadDraft((s) => s.setPassword);
  const setExpiryPreset = useUploadDraft((s) => s.setExpiryPreset);
  const updateSelected = useUploadDraft((s) => s.updateSelected);
  const resetDraft = useUploadDraft((s) => s.resetDraft);

  const [expanding, setExpanding] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);

  const tree = React.useMemo(() => buildTreeFromFiles(files), [files]);
  const summary = summarizeSelection(selected, tree);
  const totalFiles = files.length;
  const totalBytes = files.reduce((a, f) => a + f.size, 0);

  const canUpload = summary.count > 0 && name.trim().length > 0 && !starting;

  const handleAddPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    setExpanding(true);
    try {
      const expanded = await window.api.invoke("upload:expandPaths", paths);
      addFiles(expanded);
    } catch (error) {
      toast.error("파일을 불러오지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setExpanding(false);
    }
  };

  const handleFilePicker = async () => {
    const result = await window.api.invoke("util:showOpenDialog", {
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) return;
    void handleAddPaths(result.filePaths);
  };

  const handleFolderPicker = async () => {
    const result = await window.api.invoke("util:showOpenDialog", {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return;
    void handleAddPaths(result.filePaths);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const fileList = Array.from(e.dataTransfer.files);
    if (fileList.length === 0) return;
    const paths = fileList.map((f) => window.webUtils.getPathForFile(f));
    void handleAddPaths(paths);
  };

  const handleToggle = (key: string) => {
    updateSelected((prev) => toggleTreeSelection(prev, key, tree));
  };

  const handleStart = async () => {
    if (!canUpload) return;
    setStarting(true);
    try {
      const turnstileToken = await window.api.invoke("upload:solveTurnstile");

      const selectedFiles = files.filter((f) => {
        const normalized = f.path;
        for (let i = 1; i <= normalized.split("/").length; i++) {
          if (selected.has(normalized.split("/").slice(0, i).join("/"))) return true;
        }
        return false;
      });

      const created = await window.api.invoke("upload:create", {
        tree: selectedFiles,
        options: {
          name: name.trim().slice(0, MAX_NAME),
          description: description.slice(0, MAX_DESCRIPTION),
          password: password || "",
          expires: resolveExpiryTimestamp(expiryPreset),
          eternal: expiryPreset === "eternal",
        },
        turnstileToken,
      });

      if (!created) {
        throw new Error("업로드를 만들지 못했습니다.");
      }

      toast.success("업로드가 시작되었습니다", {
        description: `${name.trim()} · ${selectedFiles.length}개 파일`,
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
              <Select
                value={expiryPreset}
                onValueChange={(v) => setExpiryPreset(v as ExpiryPreset)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1d">1일</SelectItem>
                  <SelectItem value="7d">7일 (기본)</SelectItem>
                  <SelectItem value="30d">30일</SelectItem>
                  <SelectItem value="eternal">만료 없음</SelectItem>
                </SelectContent>
              </Select>
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
                <span className="text-muted-foreground">선택 파일</span>
                <span className="font-medium tabular-nums">
                  {summary.count}개 · {formatSize(summary.bytes)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">전체 파일</span>
                <span className="tabular-nums">
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
                <XIcon className="size-3" />
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
                선택 <span className="tabular-nums">{summary.count}</span> / {totalFiles} 파일
              </span>
              <span className="tabular-nums">{formatSize(summary.bytes)}</span>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2">
                <FileTree
                  mode="selection"
                  root={tree}
                  selected={selected}
                  onToggle={handleToggle}
                />
              </div>
            </ScrollArea>
          </>
        )}
      </div>
    </div>
  );
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
