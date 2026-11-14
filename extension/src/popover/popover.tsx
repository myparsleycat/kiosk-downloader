import {
  discardShareDraft,
  listZipEntries,
  prepareShare,
  runLaunchingApp,
  sendItemsLaunchingApp,
  startDownload,
} from "@ext/background/app-client";
import type { AppFailure } from "@ext/shared/messages";
import {
  POPOVER_MESSAGE_TYPE,
  type PopoverFrameMessage,
  type PopoverSession,
  takePopoverSession,
} from "@ext/shared/popover";
import { FileTree } from "@renderer/components/tree/file-tree";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Input } from "@renderer/components/ui/input";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import {
  collectAllPaths,
  countFiles,
  getTreeSelectionState,
  selectExpandedZipEntries,
  sortTree,
  summarizeSelection,
  toggleTreeSelection,
} from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import type { Collection } from "@shared/types";
import { formatSize } from "@shared/utils";
import { setZipEntries } from "@shared/zip-tree";
import { CheckIcon, Loader2Icon, LockIcon, XIcon } from "lucide-react";
import * as React from "react";

const CLOSE_AFTER_START_MS = 1500;

type PopoverState =
  | { status: "loading" }
  | { status: "password"; invalid: boolean }
  | { status: "ready"; draftId: string; collection: Collection; savePath: string }
  | { status: "started"; name: string }
  | { status: "error"; message: string };

export function Popover() {
  const [session, setSession] = React.useState<PopoverSession | null>(null);
  const [state, setState] = React.useState<PopoverState>({ status: "loading" });
  const pendingDraftId = React.useRef<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const prepare = async (target: PopoverSession, password?: string) => {
    setState({ status: "loading" });
    const result = await runLaunchingApp(
      () => prepareShare({ url: target.url, headers: target.headers, password }),
      undefined,
    );
    if (!result.ok) {
      setState({ status: "error", message: describeFailure(result) });
      return;
    }
    const prepared = result.value;
    if (prepared.status === "passwordRequired") {
      setState({ status: "password", invalid: prepared.invalid });
      return;
    }
    if (prepared.status === "failed") {
      setState({ status: "error", message: prepared.message });
      return;
    }
    pendingDraftId.current = prepared.draftId;
    setState({
      status: "ready",
      draftId: prepared.draftId,
      collection: prepared.collection,
      savePath: prepared.savePath,
    });
  };

  React.useEffect(() => {
    takePopoverSession(location.hash.slice(1)).then(
      (stored) => {
        if (!stored) {
          setState({ status: "error", message: "링크 정보가 없습니다. 버튼을 다시 누르세요." });
          return;
        }
        setSession(stored);
        void prepare(stored);
      },
      (error: unknown) => setState({ status: "error", message: String(error) }),
    );
  }, []);

  React.useEffect(() => {
    const discard = () => {
      if (pendingDraftId.current) void discardShareDraft(pendingDraftId.current);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") postToHost({ type: POPOVER_MESSAGE_TYPE, action: "close" });
    };
    window.addEventListener("pagehide", discard);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pagehide", discard);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() =>
      postToHost({
        type: POPOVER_MESSAGE_TYPE,
        action: "resize",
        height: Math.ceil(root.getBoundingClientRect().height),
      }),
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const sendToApp = async () => {
    if (!session) return;
    if (pendingDraftId.current) {
      void discardShareDraft(pendingDraftId.current);
      pendingDraftId.current = null;
    }
    setState({ status: "loading" });
    const result = await sendItemsLaunchingApp(
      [{ url: session.url, headers: session.headers, source: "link" }],
      undefined,
    );
    if (!result.ok) {
      setState({ status: "error", message: describeFailure(result) });
      return;
    }
    close();
  };

  const onStarted = (name: string) => {
    pendingDraftId.current = null;
    setState({ status: "started", name });
    window.setTimeout(close, CLOSE_AFTER_START_MS);
  };

  return (
    <div ref={rootRef} className="flex flex-col text-sm">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <img src="/icons/icon-32.png" alt="" className="size-4" />
        <p
          className="min-w-0 flex-1 truncate font-medium"
          title={state.status === "ready" ? state.collection.name : undefined}
        >
          {state.status === "ready" ? state.collection.name : "Kiosk Downloader"}
        </p>
        <Button variant="ghost" size="icon-xs" aria-label="닫기" onClick={close}>
          <XIcon />
        </Button>
      </div>

      {state.status === "loading" && (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          링크 정보를 불러오는 중
        </div>
      )}

      {state.status === "password" && session && (
        <PasswordForm
          invalid={state.invalid}
          onSubmit={(password) => void prepare(session, password)}
        />
      )}

      {state.status === "ready" && (
        <ReadyView
          key={state.draftId}
          draftId={state.draftId}
          collection={state.collection}
          savePath={state.savePath}
          onSendToApp={() => void sendToApp()}
          onStarted={onStarted}
        />
      )}

      {state.status === "started" && (
        <div className="flex items-center gap-2 px-3 py-4 text-xs">
          <CheckIcon className="size-3.5 text-green-600" />
          <span className="min-w-0 truncate">다운로드를 시작했습니다: {state.name}</span>
        </div>
      )}

      {state.status === "error" && (
        <div className="flex flex-col gap-3 px-3 py-3">
          <p className="text-xs break-words text-destructive">{state.message}</p>
          {session && (
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => void sendToApp()}>
                앱으로 보내기
              </Button>
              <Button size="sm" onClick={() => void prepare(session)}>
                다시 시도
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReadyView({
  draftId,
  collection,
  savePath,
  onSendToApp,
  onStarted,
}: {
  draftId: string;
  collection: Collection;
  savePath: string;
  onSendToApp: () => void;
  onStarted: (name: string) => void;
}) {
  const [root, setRoot] = React.useState(collection.tree);
  const tree = React.useMemo(() => sortTree(root, "name", "none", true), [root]);
  const [selected, setSelected] = React.useState(() => collectAllPaths(collection.tree));
  const [zipLoadingPaths, setZipLoadingPaths] = React.useState<Set<string>>(() => new Set());
  const [zipPasswords, setZipPasswords] = React.useState<Record<string, string>>({});
  const [zipPrompt, setZipPrompt] = React.useState<{
    path: string;
    fileId: string;
    invalid: boolean;
  } | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const summary = summarizeSelection(selected, root);
  const selectionState = getTreeSelectionState(selected, root);

  const expandZip = async (zipPath: string, fileId: string, zipPassword?: string) => {
    setZipLoadingPaths((current) => new Set(current).add(zipPath));
    setError(null);
    const result = await listZipEntries({ draftId, fileId, zipPassword });
    setZipLoadingPaths((current) => {
      const next = new Set(current);
      next.delete(zipPath);
      return next;
    });
    if (!result.ok) {
      setError(describeFailure(result));
      return;
    }
    const listed = result.value;
    if (listed.status === "passwordRequired") {
      setZipPrompt({ path: zipPath, fileId, invalid: listed.invalid });
      return;
    }
    if (listed.status === "failed") {
      setError(listed.message);
      return;
    }
    if (zipPassword) setZipPasswords((current) => ({ ...current, [fileId]: zipPassword }));
    setZipPrompt(null);
    setRoot((current) => setZipEntries(current, fileId, listed.entries));
    // Only the expanded ZIP's own node is read, so the tree from this render is enough here.
    const expanded = setZipEntries(root, fileId, listed.entries);
    setSelected((current) => selectExpandedZipEntries(current, expanded, zipPath, fileId));
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    const result = await startDownload({
      draftId,
      selectedPaths: [...selected],
      zipPasswords: Object.keys(zipPasswords).length > 0 ? zipPasswords : undefined,
    });
    setStarting(false);
    if (!result.ok) {
      setError(describeFailure(result));
      return;
    }
    onStarted(result.value.name);
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <Checkbox
          checked={selectionState === true}
          indeterminate={selectionState === "indeterminate"}
          onCheckedChange={() =>
            setSelected(selectionState === true ? new Set() : collectAllPaths(root))
          }
          aria-label={selectionState === true ? "전체 해제" : "전체 선택"}
          className="after:hidden"
        />
        <span className="flex-1 tabular-nums">
          {summary.count} / {countFiles(root)} 파일
        </span>
        <span className="tabular-nums">{formatSize(summary.bytes)}</span>
      </div>
      <ScrollArea viewportClassName="max-h-72">
        <div className="p-1">
          <FileTree
            mode="selection"
            root={tree}
            selected={selected}
            onToggle={(key) => setSelected((current) => toggleTreeSelection(current, key, root))}
            onExpandZip={
              collection.provider === "kiosk"
                ? (zipPath, fileId) => void expandZip(zipPath, fileId, zipPasswords[fileId])
                : undefined
            }
            zipLoadingPaths={zipLoadingPaths}
          />
        </div>
      </ScrollArea>
      {zipPrompt && (
        <PasswordForm
          key={`${zipPrompt.fileId}:${String(zipPrompt.invalid)}`}
          label={`${zipPrompt.path} 파일을 열려면 비밀번호가 필요합니다.`}
          invalid={zipPrompt.invalid}
          className="border-t"
          onCancel={() => setZipPrompt(null)}
          onSubmit={(password) => void expandZip(zipPrompt.path, zipPrompt.fileId, password)}
        />
      )}
      <div className="flex flex-col gap-2 border-t px-3 py-2">
        <p className="truncate text-xs text-muted-foreground" title={savePath}>
          저장 위치: {savePath}
        </p>
        {error && <p className="text-xs break-words text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={starting} onClick={onSendToApp}>
            앱에서 열기
          </Button>
          <Button size="sm" disabled={starting || summary.count === 0} onClick={() => void start()}>
            {starting && <Loader2Icon className="animate-spin" />}
            다운로드
          </Button>
        </div>
      </div>
    </div>
  );
}

function PasswordForm({
  label = "비밀번호가 필요합니다.",
  invalid,
  className,
  onCancel,
  onSubmit,
}: {
  label?: string;
  invalid: boolean;
  className?: string;
  onCancel?: () => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = React.useState("");

  return (
    <form
      className={cn("flex flex-col gap-2 px-3 py-3", className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (password) onSubmit(password);
      }}
    >
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <LockIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 break-all">{label}</span>
      </p>
      <div className="flex gap-2">
        <Input
          type="password"
          autoFocus
          value={password}
          className="h-7"
          aria-invalid={invalid || undefined}
          onChange={(event) => setPassword(event.target.value)}
        />
        {onCancel && (
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            취소
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!password}>
          확인
        </Button>
      </div>
      {invalid && <p className="text-xs text-destructive">비밀번호가 올바르지 않습니다.</p>}
    </form>
  );
}

function describeFailure(failure: AppFailure) {
  if (failure.reason === "offline") return "Kiosk Downloader가 실행 중이 아닙니다.";
  if (failure.reason === "outdated") {
    return "Kiosk Downloader를 최신 버전으로 업데이트하세요.";
  }
  if (failure.reason === "pairingDenied") return "Kiosk Downloader에서 연결이 거부되었습니다.";
  return failure.message ?? "알 수 없는 오류가 발생했습니다.";
}

function close() {
  postToHost({ type: POPOVER_MESSAGE_TYPE, action: "close" });
}

// The host page's origin is not known to the frame; the messages carry no page data.
function postToHost(message: PopoverFrameMessage) {
  window.parent.postMessage(message, "*");
}
