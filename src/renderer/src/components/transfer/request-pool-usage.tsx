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
      title={
        usage.limit === undefined
          ? "전송 요청 풀 사용량 (진행 중 요청 · 대기 요청)"
          : "전송 요청 풀 사용량 (진행 중 요청 · 대기 요청 · 서버 동시 요청 상한). 상한은 같은 서버의 모든 다운로드에 합산하여 적용됩니다."
      }
    >
      <LayersIcon className="size-2.5" />
      요청 풀 {usage.inFlight}
      {usage.pending > 0 && <span>· 대기 {usage.pending}</span>}
      {usage.limit !== undefined && <span>· 서버 상한 {usage.limit}</span>}
    </span>
  );
}
