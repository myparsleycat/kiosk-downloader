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
import * as React from "react";
import { toast } from "sonner";

interface RemoveTransferOptions {
  removeById: (id: string) => Promise<unknown>;
  errorMessage: string;
  dialogTitle: string;
  dialogDescription: string;
}

export function useRemoveTransfer<TItem extends { id: string; status: string }>(
  options: RemoveTransferOptions,
) {
  const [target, setTarget] = React.useState<TItem | null>(null);
  const [removing, setRemoving] = React.useState(false);

  const executeRemove = async (id: string) => {
    setRemoving(true);
    try {
      await options.removeById(id);
    } catch (error) {
      toast.error(options.errorMessage, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRemoving(false);
      setTarget(null);
    }
  };

  const remove = (item: TItem) => {
    if (item.status !== "completed") {
      setTarget(item);
      return;
    }
    void executeRemove(item.id);
  };

  const removeCompleted = async (items: TItem[]) => {
    const completed = items.filter((item) => item.status === "completed");
    if (completed.length === 0) return;

    setRemoving(true);
    let firstError: Error | undefined;
    try {
      for (const item of completed) {
        try {
          await options.removeById(item.id);
        } catch (error) {
          firstError ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      if (firstError) {
        toast.error(options.errorMessage, {
          description: firstError.message,
        });
      }
    } finally {
      setRemoving(false);
    }
  };

  const dialog = (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !removing) setTarget(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{options.dialogTitle}</AlertDialogTitle>
          <AlertDialogDescription>{options.dialogDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>취소</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={removing}
            isLoading={removing}
            onClick={() => target && void executeRemove(target.id)}
          >
            삭제
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { remove, removeCompleted, dialog, removing };
}
