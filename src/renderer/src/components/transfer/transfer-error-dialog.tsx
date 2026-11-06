import type { FileTreeError } from "@renderer/components/tree/file-tree";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";

export function TransferErrorDialog({
  title,
  errors,
  onOpenChange,
}: {
  title: string;
  errors: FileTreeError[] | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={errors !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{errors?.length ?? 0}개 오류가 발생했습니다.</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-3 overflow-y-auto rounded-md border bg-muted/30 p-3">
          {errors?.map((error) => (
            <div key={`${error.path}:${error.message}`} className="space-y-1 text-xs">
              <p className="font-medium break-all">{error.path}</p>
              <pre className="text-destructive whitespace-pre-wrap break-words font-mono">
                {error.message}
              </pre>
            </div>
          ))}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
