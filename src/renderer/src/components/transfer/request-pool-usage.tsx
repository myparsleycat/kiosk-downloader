import type { RequestPoolUsage } from "@shared/types";
import { LayersIcon } from "lucide-react";

export function RequestPoolUsageLabel({
  usage,
  active,
}: {
  usage?: RequestPoolUsage;
  active: boolean;
}) {
  if (!active || !usage) {
    return null;
  }
  return (
    <span
      className="flex items-center gap-0.5 tabular-nums"
      title="전송 요청 풀 사용량 (진행 중 요청 · 대기 요청)"
    >
      <LayersIcon className="size-2.5" />
      요청 풀 {usage.inFlight}
      {usage.pending > 0 && <span>· 대기 {usage.pending}</span>}
    </span>
  );
}
