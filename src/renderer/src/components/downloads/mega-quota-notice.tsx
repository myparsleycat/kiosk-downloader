import { Alert, AlertAction, AlertDescription, AlertTitle } from "@renderer/components/ui/alert";
import { Button } from "@renderer/components/ui/button";
import { useAppNavigation } from "@renderer/stores/app-navigation";
import { useMegaStatus } from "@renderer/stores/mega-status";
import { getAutoResumeTime } from "@shared/pause-reason";
import type { DownloadPauseReason } from "@shared/types";
import { CircleAlertIcon } from "lucide-react";
import * as React from "react";

const LOGIN_HINT = "Mega 계정으로 로그인하면 계정 한도를 사용할 수 있습니다.";

export function MegaQuotaAlert({ reason }: { reason: DownloadPauseReason }) {
  const loggedIn = useMegaStatus((state) => state.loggedIn);
  const autoResume = useMegaStatus((state) => state.autoResume);
  const openSettings = useAppNavigation((state) => state.openSettings);
  const now = useNow();

  return (
    <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
      <CircleAlertIcon />
      <AlertTitle>Mega 전송 한도 초과로 일시정지됨</AlertTitle>
      <AlertDescription className="text-amber-800/90 dark:text-amber-300/90">
        {formatWait(reason, autoResume, now)}
        {!loggedIn && ` ${LOGIN_HINT}`}
      </AlertDescription>
      {!loggedIn && (
        <AlertAction>
          <Button type="button" size="xs" variant="outline" onClick={() => openSettings("account")}>
            로그인
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

export function MegaQuotaCardLine({ reason }: { reason: DownloadPauseReason }) {
  const autoResume = useMegaStatus((state) => state.autoResume);
  const now = useNow();
  const target = autoResume ? getAutoResumeTime(reason) : reason.resumeAt;
  const label =
    target === null
      ? "한도 초과"
      : `한도 초과 · ${target <= now ? "곧" : `약 ${minutesUntil(target, now)}분 후`} ${
          autoResume ? "자동 재개" : "재개 가능"
        }`;
  return <p className="truncate text-[10px] text-muted-foreground">{label}</p>;
}

function formatWait(reason: DownloadPauseReason, autoResume: boolean, now: number) {
  if (autoResume) {
    const target = getAutoResumeTime(reason);
    return target <= now
      ? "곧 자동으로 재개됩니다."
      : `약 ${minutesUntil(target, now)}분 후 자동으로 재개됩니다.`;
  }
  if (reason.resumeAt === null) {
    return "한도가 복구된 뒤 재개하세요.";
  }
  if (reason.resumeAt <= now) {
    return "지금 재개할 수 있습니다.";
  }
  const time = new Date(reason.resumeAt).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `약 ${minutesUntil(reason.resumeAt, now)}분 후(${time}) 재개할 수 있습니다.`;
}

function minutesUntil(target: number, now: number) {
  return Math.max(1, Math.ceil((target - now) / 60_000));
}

function useNow(intervalMs = 30_000) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
