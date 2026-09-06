import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { BrushCleaningIcon, PauseIcon, PlayIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";

export type BulkTransferLoading = "start" | "pause" | "delete" | "cleanup";

export function BulkTransferButtons({
  canStart,
  canPause,
  canDelete,
  canCleanup,
  busy,
  loading,
  onStart,
  onPause,
  onDelete,
  onCleanup,
}: {
  canStart: boolean;
  canPause: boolean;
  canDelete: boolean;
  canCleanup: boolean;
  busy: boolean;
  loading: BulkTransferLoading | null;
  onStart: () => void;
  onPause: () => void;
  onDelete: () => void;
  onCleanup: () => void;
}) {
  const locked = busy || loading !== null;
  return (
    <div className="ml-auto flex items-center">
      <ActionButton
        label="일괄 시작"
        disabled={!canStart || locked}
        isLoading={loading === "start"}
        onClick={onStart}
      >
        <PlayIcon className="size-3.5" />
      </ActionButton>
      <ActionButton
        label="일괄 일시정지"
        disabled={!canPause || locked}
        isLoading={loading === "pause"}
        onClick={onPause}
      >
        <PauseIcon className="size-3.5" />
      </ActionButton>
      <ActionButton
        label="일괄 삭제"
        disabled={!canDelete || locked}
        isLoading={loading === "delete"}
        onClick={onDelete}
      >
        <Trash2Icon className="size-3.5" />
      </ActionButton>
      <ActionButton
        label="완료된 항목 제거"
        disabled={!canCleanup || locked}
        isLoading={loading === "cleanup"}
        onClick={onCleanup}
      >
        <BrushCleaningIcon className="size-3.5" />
      </ActionButton>
    </div>
  );
}

function ActionButton({
  label,
  disabled,
  isLoading,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  isLoading: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            isLoading={isLoading}
            onClick={onClick}
            className="size-6 text-muted-foreground"
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
