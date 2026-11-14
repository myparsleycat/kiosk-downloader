import { ConnectionStatus } from "@ext/shared/connection-status";
import { useExtensionSettings } from "@ext/shared/hooks";
import { SettingRow } from "@renderer/components/settings/setting-layout";
import { Button } from "@renderer/components/ui/button";
import { Separator } from "@renderer/components/ui/separator";
import { Switch } from "@renderer/components/ui/switch";
import { SettingsIcon } from "lucide-react";

export function Popup() {
  const { settings, update, error } = useExtensionSettings();

  return (
    <div className="flex w-80 flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 px-3.5 py-3">
        <img src="/icons/icon-32.png" alt="" className="size-5" />
        <h1 className="flex-1 text-sm font-medium">kioex</h1>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="설정"
          onClick={() => void chrome.runtime.openOptionsPage()}
        >
          <SettingsIcon />
        </Button>
      </div>
      <Separator />
      <ConnectionStatus className="px-3.5 py-2.5" />
      <Separator />
      {settings && (
        <div className="flex flex-col">
          <SettingRow
            title="링크 버튼"
            description="지원하는 링크 옆에 다운로드 버튼을 표시합니다."
            control={
              <Switch
                checked={settings.linkButtons.enabled}
                onCheckedChange={(enabled) =>
                  update((current) => ({
                    ...current,
                    linkButtons: { ...current.linkButtons, enabled },
                  }))
                }
              />
            }
          />
          <SettingRow
            title="다운로드 가로채기"
            description="브라우저 다운로드를 Kiosk Downloader로 보냅니다."
            control={
              <Switch
                checked={settings.intercept.enabled}
                onCheckedChange={(enabled) =>
                  update((current) => ({
                    ...current,
                    intercept: { ...current.intercept, enabled },
                  }))
                }
              />
            }
          />
        </div>
      )}
      {error && <p className="px-3.5 pb-3 text-xs text-destructive">{error}</p>}
    </div>
  );
}
