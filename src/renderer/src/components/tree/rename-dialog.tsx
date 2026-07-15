import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { validateNodeName } from "@shared/tree-rename";
import * as React from "react";

export type RenameTargetKind = "file" | "dir" | "zip";

export type RenameTarget = {
  path: string;
  name: string;
  kind: RenameTargetKind;
};

export function RenameDialog({
  target,
  error,
  onOpenChange,
  onConfirm,
}: {
  target: RenameTarget | null;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => void;
}) {
  const [value, setValue] = React.useState("");
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [ignoreExternalError, setIgnoreExternalError] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!target) {
      return;
    }
    setValue(target.name);
    setLocalError(null);
    setIgnoreExternalError(false);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [target]);

  React.useEffect(() => {
    setIgnoreExternalError(false);
  }, [error]);

  const kindLabel = target?.kind === "dir" ? "폴더" : target?.kind === "zip" ? "ZIP" : "파일";
  const validationError = validateNodeName(value);
  const displayError = localError ?? (ignoreExternalError ? null : (error ?? null));
  const canSubmit = validationError === null && value.trim() !== target?.name;

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{kindLabel} 이름 변경</DialogTitle>
          <DialogDescription>다운로드/업로드에 사용될 이름을 입력하세요.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const next = value.trim();
            const message = validateNodeName(next);
            if (message) {
              setLocalError(message);
              return;
            }
            if (next === target?.name) {
              onOpenChange(false);
              return;
            }
            setLocalError(null);
            onConfirm(next);
          }}
        >
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setLocalError(null);
              setIgnoreExternalError(true);
            }}
            aria-invalid={displayError !== null || validationError !== null}
          />
          {(displayError || (value.length > 0 && validationError)) && (
            <p className="text-xs text-destructive">{displayError ?? validationError}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              변경
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
