import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { BROWSER_EXTENSION_PAIRING_PROTOCOL } from "@shared/browser-extension";

import { useAppConnection } from "./hooks";

export function ConnectionStatus({ className }: { className?: string }) {
  const app = useAppConnection();
  const state = app.connection?.state;
  const outdated =
    app.connection &&
    app.connection.state !== "offline" &&
    app.connection.protocol < BROWSER_EXTENSION_PAIRING_PROTOCOL;

  const label = outdated
    ? "Kiosk Downloader를 최신 버전으로 업데이트하세요"
    : app.connection?.state === "connected"
      ? `연결됨 (v${app.connection.version})`
      : state === "pairingRequired"
        ? "앱에서 연결 승인이 필요합니다"
        : state === "offline"
          ? "Kiosk Downloader가 실행 중이 아닙니다"
          : "확인 중…";

  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            state === "connected" && !outdated
              ? "bg-green-500"
              : state === "pairingRequired" || outdated
                ? "bg-amber-500"
                : "bg-muted-foreground/40",
          )}
        />
        <span className="truncate text-xs text-muted-foreground">{label}</span>
      </div>
      {state === "pairingRequired" && !outdated && (
        <Button size="sm" variant="outline" isLoading={app.busy} onClick={() => void app.pair()}>
          연결 요청
        </Button>
      )}
      {state === "offline" && (
        <Button size="sm" variant="outline" isLoading={app.busy} onClick={() => void app.launch()}>
          앱 실행
        </Button>
      )}
    </div>
  );
}
