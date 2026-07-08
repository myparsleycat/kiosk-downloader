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
import type { DownloadItem, DownloadStatus } from "@renderer/lib/types";
import * as React from "react";
import { toast } from "sonner";

export function isTransferIncomplete(status: DownloadStatus): boolean {
  return status !== "completed";
}

export function useRemoveCollection() {
  const [target, setTarget] = React.useState<DownloadItem | null>(null);
  const [removing, setRemoving] = React.useState(false);

  const executeRemove = async (id: string) => {
    setRemoving(true);
    try {
      await window.api.invoke("download:remove", id);
    } catch (error) {
      toast.error("작업을 완료하지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRemoving(false);
      setTarget(null);
    }
  };

  const remove = (item: DownloadItem) => {
    if (isTransferIncomplete(item.status)) {
      setTarget(item);
      return;
    }
    void executeRemove(item.id);
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
          <AlertDialogTitle>컬렉션 삭제</AlertDialogTitle>
          <AlertDialogDescription>
            아직 완료되지 않은 전송입니다. 정말 삭제하시겠습니까?
          </AlertDialogDescription>
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

  return { remove, dialog, removing };
}
