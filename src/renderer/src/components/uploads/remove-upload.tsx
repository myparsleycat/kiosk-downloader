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
import type { UploadItem, UploadStatus } from "@shared/types";
import * as React from "react";
import { toast } from "sonner";

function isUploadIncomplete(status: UploadStatus) {
  return status !== "completed";
}

export function useRemoveUpload() {
  const [target, setTarget] = React.useState<UploadItem | null>(null);
  const [removing, setRemoving] = React.useState(false);

  const executeRemove = async (id: string) => {
    setRemoving(true);
    try {
      await window.api.invoke("upload:remove", id);
    } catch (error) {
      toast.error("삭제하지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRemoving(false);
      setTarget(null);
    }
  };

  const remove = (item: UploadItem) => {
    if (isUploadIncomplete(item.status)) {
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
          <AlertDialogTitle>업로드 삭제</AlertDialogTitle>
          <AlertDialogDescription>
            아직 완료되지 않은 업로드입니다. 정말 삭제하시겠습니까?
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
