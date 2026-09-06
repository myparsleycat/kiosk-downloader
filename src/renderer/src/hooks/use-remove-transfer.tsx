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
import { runBulkItemActions, shouldConfirmBulkRemove } from "@renderer/lib/bulk-transfer";
import * as React from "react";
import { toast } from "sonner";

interface RemoveTransferOptions {
  removeById: (id: string) => Promise<unknown>;
  errorMessage: string;
  dialogTitle: string;
  dialogDescription: string;
  bulkDialogTitle: string;
  bulkDialogDescription: string;
}

type RemoveTarget<TItem> = { type: "one"; item: TItem } | { type: "all"; items: TItem[] };

export type RemovingKind = "one" | "completed" | "all";

export function useRemoveTransfer<TItem extends { id: string; status: string }>(
  options: RemoveTransferOptions,
) {
  const [target, setTarget] = React.useState<RemoveTarget<TItem> | null>(null);
  const [removingKind, setRemovingKind] = React.useState<RemovingKind | null>(null);
  const removing = removingKind !== null;

  const executeRemoveMany = async (items: TItem[], kind: RemovingKind) => {
    setRemovingKind(kind);
    try {
      const firstError = await runBulkItemActions(items, (item) => options.removeById(item.id));
      if (firstError) {
        toast.error(options.errorMessage, {
          description: firstError.message,
        });
      }
    } finally {
      setRemovingKind(null);
      setTarget(null);
    }
  };

  const remove = (item: TItem) => {
    if (item.status !== "completed") {
      setTarget({ type: "one", item });
      return;
    }
    void executeRemoveMany([item], "one");
  };

  const removeCompleted = async (items: TItem[]) => {
    const completed = items.filter((item) => item.status === "completed");
    if (completed.length === 0) return;
    await executeRemoveMany(completed, "completed");
  };

  const removeAll = (items: TItem[]) => {
    if (items.length === 0) return;
    if (shouldConfirmBulkRemove(items)) {
      setTarget({ type: "all", items });
      return;
    }
    void executeRemoveMany(items, "all");
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
          <AlertDialogTitle>
            {target?.type === "all" ? options.bulkDialogTitle : options.dialogTitle}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target?.type === "all" ? options.bulkDialogDescription : options.dialogDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>취소</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={removing}
            isLoading={removing}
            onClick={() => {
              if (!target) return;
              if (target.type === "all") {
                void executeRemoveMany(target.items, "all");
                return;
              }
              void executeRemoveMany([target.item], "one");
            }}
          >
            삭제
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return {
    remove,
    removeCompleted,
    removeAll,
    dialog,
    removing,
    removingKind,
    confirming: target !== null,
  };
}
