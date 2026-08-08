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
import type { TransferControl } from "@shared/types";
import * as React from "react";

type StopTarget = {
  scope: "collection" | "file";
  action: () => Promise<unknown>;
};

export function useConfirmDownloadStop() {
  const [target, setTarget] = React.useState<StopTarget | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  const runWithStopConfirmation = (
    transferControl: TransferControl | undefined,
    scope: StopTarget["scope"],
    action: StopTarget["action"],
  ) => {
    if (transferControl !== "stop") {
      void action();
      return;
    }
    setTarget({ scope, action });
  };

  const confirm = async () => {
    if (!target || confirming) return;
    setConfirming(true);
    try {
      await target.action();
    } finally {
      setConfirming(false);
      setTarget(null);
    }
  };

  const dialog = (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !confirming) setTarget(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target?.scope === "file"
              ? "파일 다운로드를 정지하시겠습니까?"
              : "다운로드를 정지하시겠습니까?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target?.scope === "file"
              ? "이 파일은 이어받기를 지원하지 않습니다. 정지하면 현재 진행 내용이 삭제되며, 다시 시작할 때 0%부터 다운로드됩니다."
              : "이어받기를 지원하지 않는 파일의 현재 진행 내용은 삭제됩니다. 이어받기 가능한 파일은 진행 내용이 유지됩니다. 삭제된 파일은 다시 시작할 때 0%부터 다운로드됩니다."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={confirming}>취소</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={confirming}
            isLoading={confirming}
            onClick={() => void confirm()}
          >
            정지
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { runWithStopConfirmation, dialog };
}
