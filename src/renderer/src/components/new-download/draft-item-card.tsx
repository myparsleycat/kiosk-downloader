import { Button } from "@renderer/components/ui/button";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { Input } from "@renderer/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@renderer/components/ui/input-group";
import { countFiles, dirTotalSize } from "@renderer/lib/types";
import { itemDisplayTree, type NewDownloadItem } from "@renderer/stores/new-download-draft";
import { tryParseDownloadUrl } from "@shared/share-url";
import type { DirectRequestHeaders } from "@shared/types";
import { formatSize } from "@shared/utils";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";

export function DraftItemCard({
  item,
  extendedLoadProgress,
  onPasswordChange,
  onVerifyPassword,
  onRetry,
  onRemove,
  onHeadersChange,
}: {
  item: NewDownloadItem;
  extendedLoadProgress: { current: number; total: number } | null;
  onPasswordChange: (value: string) => void;
  onVerifyPassword: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onHeadersChange: (headers: DirectRequestHeaders) => void;
}) {
  const title = item.preparation.status === "ready" ? item.preparation.collection.name : item.url;
  const tree = itemDisplayTree(item);
  const files = tree ? countFiles(tree) : 0;
  const bytes = tree ? dirTotalSize(tree) : 0;
  const passwordInvalid =
    item.preparation.status === "passwordRequired" && item.preparation.invalid;
  const secretLabel = tryParseDownloadUrl(item.url)?.provider === "mega" ? "복호화 키" : "비밀번호";

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
            <p className="text-[11px] text-muted-foreground">{secretLabel} 필요</p>
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
              placeholder={`${secretLabel} 입력`}
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
                aria-label={`${secretLabel} 확인`}
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
      {isDirectDraftItem(item) ? (
        <DirectHeadersFields
          headers={item.headers}
          forceOpen={
            item.preparation.status === "error" && /HTTP 40[13]\b/.test(item.preparation.message)
          }
          disabled={item.preparation.status === "preparing"}
          onChange={onHeadersChange}
          onApply={onRetry}
        />
      ) : null}
    </div>
  );
}

export function isDirectDraftItem(item: NewDownloadItem) {
  return tryParseDownloadUrl(item.url)?.provider === "direct";
}

const DIRECT_HEADER_FIELDS = [
  { key: "referer", label: "Referer", placeholder: "https://example.com/page", secret: false },
  { key: "cookie", label: "Cookie", placeholder: "name=value; other=value", secret: true },
  { key: "userAgent", label: "User-Agent", placeholder: "기본값 사용", secret: false },
] as const;

export function DirectHeadersFields({
  headers,
  forceOpen = false,
  disabled = false,
  onChange,
  onApply,
}: {
  headers: DirectRequestHeaders;
  forceOpen?: boolean;
  disabled?: boolean;
  onChange: (headers: DirectRequestHeaders) => void;
  onApply: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const expanded = open || forceOpen;
  const configured = DIRECT_HEADER_FIELDS.filter((field) => headers[field.key]?.trim()).length;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="flex items-center gap-1 self-start text-[11px] text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
      >
        {expanded ? (
          <ChevronDownIcon className="size-3" />
        ) : (
          <ChevronRightIcon className="size-3" />
        )}
        요청 헤더{configured > 0 ? ` (${configured})` : ""}
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2">
          {DIRECT_HEADER_FIELDS.map((field) => (
            <Field key={field.key} className="gap-1">
              <FieldLabel className="text-[11px]">{field.label}</FieldLabel>
              <Input
                className="h-7 text-xs"
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                placeholder={field.placeholder}
                value={headers[field.key] ?? ""}
                disabled={disabled}
                onChange={(event) => onChange({ ...headers, [field.key]: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  onApply();
                }}
              />
            </Field>
          ))}
          <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={onApply}>
            <RefreshCwIcon />
            헤더 적용 후 다시 불러오기
          </Button>
        </div>
      ) : null}
    </div>
  );
}
