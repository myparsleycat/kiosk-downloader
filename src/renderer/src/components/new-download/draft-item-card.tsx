import { Button } from "@renderer/components/ui/button";
import { Field } from "@renderer/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@renderer/components/ui/input-group";
import { countFiles, dirTotalSize } from "@renderer/lib/types";
import { itemDisplayTree, type NewDownloadItem } from "@renderer/stores/new-download-draft";
import { formatSize } from "@shared/utils";
import { CheckIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";

export function DraftItemCard({
  item,
  extendedLoadProgress,
  onPasswordChange,
  onVerifyPassword,
  onRetry,
  onRemove,
}: {
  item: NewDownloadItem;
  extendedLoadProgress: { current: number; total: number } | null;
  onPasswordChange: (value: string) => void;
  onVerifyPassword: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const title = item.preparation.status === "ready" ? item.preparation.collection.name : item.url;
  const tree = itemDisplayTree(item);
  const files = tree ? countFiles(tree) : 0;
  const bytes = tree ? dirTotalSize(tree) : 0;
  const passwordInvalid =
    item.preparation.status === "passwordRequired" && item.preparation.invalid;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={title}>
            {title}
          </p>
          {item.preparation.status === "ready" ? (
            <p className="text-[11px] text-muted-foreground">
              {files}개 · {formatSize(bytes)}
            </p>
          ) : item.preparation.status === "preparing" ? (
            <p className="text-[11px] text-muted-foreground">불러오는 중</p>
          ) : item.preparation.status === "passwordRequired" ? (
            <p className="text-[11px] text-muted-foreground">비밀번호 필요</p>
          ) : item.preparation.status === "error" ? (
            <p className="text-[11px] text-destructive">{item.preparation.message}</p>
          ) : null}
          {item.preparation.status === "preparing" &&
            extendedLoadProgress &&
            extendedLoadProgress.total > 0 && (
              <p className="text-[11px] text-muted-foreground">
                컬렉션 {extendedLoadProgress.current}/{extendedLoadProgress.total}
              </p>
            )}
        </div>
        {item.preparation.status === "preparing" ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
        <Button type="button" variant="ghost" size="icon-xs" aria-label="제거" onClick={onRemove}>
          <XIcon />
        </Button>
      </div>
      {item.preparation.status === "passwordRequired" ? (
        <Field {...(passwordInvalid ? { "data-invalid": true } : {})}>
          <InputGroup>
            <InputGroupInput
              placeholder="비밀번호 입력"
              value={item.password}
              aria-invalid={passwordInvalid || undefined}
              onChange={(event) => onPasswordChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                onVerifyPassword();
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                disabled={!item.password.trim()}
                aria-label="비밀번호 확인"
                onClick={onVerifyPassword}
              >
                <CheckIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      ) : null}
      {item.preparation.status === "error" ? (
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          <RefreshCwIcon />
          다시 시도
        </Button>
      ) : null}
    </div>
  );
}
