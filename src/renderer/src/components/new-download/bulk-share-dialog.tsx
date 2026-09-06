import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@renderer/components/ui/field";
import { Textarea } from "@renderer/components/ui/textarea";
import { parseBulkShareInputs } from "@shared/share-url";
import * as React from "react";
import { toast } from "sonner";

export function BulkShareDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (urls: string[]) => void;
}) {
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      return;
    }
    setText("");
    setError(null);
  }, [open]);

  const confirm = () => {
    const parsed = parseBulkShareInputs(text);
    if (parsed.urls.length === 0) {
      setError("유효한 링크가 없습니다");
      return;
    }
    if (parsed.invalid.length > 0) {
      toast.error("유효하지 않은 링크를 건너뛰었습니다", {
        description: `${parsed.invalid.length}개`,
      });
    }
    onConfirm(parsed.urls);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>링크 일괄 추가</DialogTitle>
          <DialogDescription>
            줄바꿈 또는 쉼표로 구분해 여러 링크를 붙여넣으세요. base64로 인코딩된 링크도 사용할 수
            있습니다.
          </DialogDescription>
        </DialogHeader>
        <Field {...(error ? { "data-invalid": true } : {})}>
          <FieldLabel htmlFor="bulk-share-input">공유 링크</FieldLabel>
          <Textarea
            id="bulk-share-input"
            className="min-h-40"
            placeholder={"https://kio.ac/c/...\nhttps://transfer.it/t/..."}
            value={text}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setText(event.target.value);
              if (error) {
                setError(null);
              }
            }}
          />
          {error ? <FieldDescription>{error}</FieldDescription> : null}
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={confirm}>확인</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
