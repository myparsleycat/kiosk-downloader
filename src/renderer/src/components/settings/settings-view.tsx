import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Separator } from "@renderer/components/ui/separator";
import { Switch } from "@renderer/components/ui/switch";
import {
  type AppSettings,
  CHUNK_RETRY_DEFAULT,
  CHUNK_RETRY_MAX,
  CHUNK_RETRY_MIN,
  SEGMENT_POOL_SIZE_DEFAULT,
  SEGMENT_POOL_SIZE_MAX,
  SEGMENT_POOL_SIZE_MIN,
  SETTING_LOG_LEVELS,
  SETTING_THEMES,
  type SettingKey,
  type SettingTheme,
  STARTUP_RESUME_MODES,
  type StartupResumeMode,
  STREAM_WRITE_BATCH_BYTES_DEFAULT,
  STREAM_WRITE_BATCH_BYTES_OPTIONS,
  UPLOAD_CHUNK_RETRY_DEFAULT,
  UPLOAD_CHUNK_RETRY_MAX,
  UPLOAD_CHUNK_RETRY_MIN,
} from "@shared/settings";
import type { AppStatus } from "@shared/types";
import { formatSize } from "@shared/utils";
import {
  CpuIcon,
  DownloadIcon,
  FolderOpenIcon,
  MoonIcon,
  PowerIcon,
  SettingsIcon,
  UploadIcon,
  ZapIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

const SETTING_KEYS = [
  "general.runOnStartup",
  "general.runInBackground",
  "general.createCollectionSubfolder",
  "general.powerSaveBlockInTransfer",
  "general.logLevel",
  "general.theme",
  "transfer.segmentPoolSize",
  "transfer.maxChunkRetries",
  "transfer.uploadMaxChunkRetries",
  "transfer.streamWriteBatchBytes",
  "transfer.startupResumeMode",
  "transfer.uploadStartupResumeMode",
] as const;

type SettingsState = {
  [K in (typeof SETTING_KEYS)[number]]: AppSettings[K];
};

const DEFAULT_SETTINGS: SettingsState = {
  "general.runOnStartup": false,
  "general.runInBackground": true,
  "general.createCollectionSubfolder": true,
  "general.powerSaveBlockInTransfer": true,
  "general.logLevel": "error",
  "general.theme": "system",
  "transfer.segmentPoolSize": SEGMENT_POOL_SIZE_DEFAULT,
  "transfer.maxChunkRetries": CHUNK_RETRY_DEFAULT,
  "transfer.uploadMaxChunkRetries": UPLOAD_CHUNK_RETRY_DEFAULT,
  "transfer.streamWriteBatchBytes": STREAM_WRITE_BATCH_BYTES_DEFAULT,
  "transfer.startupResumeMode": "auto",
  "transfer.uploadStartupResumeMode": "auto",
};

const chunkRetryOptions = Array.from(
  { length: CHUNK_RETRY_MAX - CHUNK_RETRY_MIN + 1 },
  (_, index) => CHUNK_RETRY_MIN + index,
).map((value) => ({
  value: String(value),
  label: String(value),
}));

const uploadChunkRetryOptions = Array.from(
  { length: UPLOAD_CHUNK_RETRY_MAX - UPLOAD_CHUNK_RETRY_MIN + 1 },
  (_, index) => UPLOAD_CHUNK_RETRY_MIN + index,
).map((value) => ({
  value: String(value),
  label: String(value),
}));

const streamWriteBatchOptions = STREAM_WRITE_BATCH_BYTES_OPTIONS.map((value) => ({
  value: String(value),
  label: formatSize(value),
}));

const startupResumeModeLabels: Record<StartupResumeMode, string> = {
  auto: "자동",
  manual: "수동",
};

const startupResumeModeOptions = STARTUP_RESUME_MODES.map((value) => ({
  value,
  label: startupResumeModeLabels[value],
}));

const logLevelOptions = SETTING_LOG_LEVELS.map((value) => ({
  value,
  label: value,
}));

const themeLabels: Record<SettingTheme, string> = {
  system: "시스템",
  light: "라이트",
  dark: "다크",
};

const themeOptions = SETTING_THEMES.map((value) => ({
  value,
  label: themeLabels[value],
}));

export function SettingsView() {
  const [settings, setSettings] = React.useState<SettingsState>(DEFAULT_SETTINGS);
  const [appStatus, setAppStatus] = React.useState<AppStatus | null>(null);

  React.useEffect(() => {
    void window.api
      .invoke("util:getAppStatus")
      .then(setAppStatus)
      .catch((error) => {
        toast.error("앱 정보를 불러오지 못했습니다", {
          description: error instanceof Error ? error.message : String(error),
        });
      });

    window.api
      .invoke("setting:getMany", SETTING_KEYS)
      .then((values) => setSettings((prev) => ({ ...prev, ...values })))
      .catch((error) => {
        toast.error("설정을 불러오지 못했습니다", {
          description: error instanceof Error ? error.message : String(error),
        });
      });

    return window.api.on("setting:update", ({ key, value }) => {
      if ((SETTING_KEYS as readonly SettingKey[]).includes(key)) {
        setSettings((prev) => ({ ...prev, [key]: value }));
      }
    });
  }, []);

  const setSetting = async <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    try {
      const saved = await window.api.invoke("setting:set", key, value);
      setSettings((prev) => ({ ...prev, [key]: saved }));
    } catch (error) {
      toast.error("설정을 저장하지 못했습니다", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
        <div className="flex items-center gap-2">
          <SettingsIcon className="size-4 text-muted-foreground" />
          <h2 className="cn-font-heading text-base font-medium">설정</h2>
        </div>

        <Section icon={<PowerIcon className="size-3.5" />} title="일반">
          {appStatus && !appStatus.isPortable && (
            <SettingRow
              title="시작 시 실행"
              description="시스템 시작 시 Kiosk Downloader를 자동으로 실행합니다."
              control={
                <Switch
                  checked={settings["general.runOnStartup"]}
                  onCheckedChange={(value) => void setSetting("general.runOnStartup", value)}
                />
              }
            />
          )}
          <SettingRow
            title="백그라운드 실행"
            description="창을 닫아도 트레이에서 앱을 유지합니다."
            control={
              <Switch
                checked={settings["general.runInBackground"]}
                onCheckedChange={(value) => void setSetting("general.runInBackground", value)}
              />
            }
          />
        </Section>

        <Section icon={<ZapIcon className="size-3.5" />} title="전송">
          <SettingRow
            title="전송 중 절전 방지"
            description="다운로드 진행 중 시스템이 절전 모드로 전환되지 않도록 합니다."
            control={
              <Switch
                checked={settings["general.powerSaveBlockInTransfer"]}
                onCheckedChange={(value) =>
                  void setSetting("general.powerSaveBlockInTransfer", value)
                }
              />
            }
          />
        </Section>

        <Section icon={<FolderOpenIcon className="size-3.5" />} title="저장">
          <SettingRow
            title="컬렉션 이름 하위 폴더 생성"
            description="최상위 항목이 두 개 이상일 때만 저장 경로 아래에 컬렉션 이름으로 하위 폴더를 만듭니다."
            control={
              <Switch
                checked={settings["general.createCollectionSubfolder"]}
                onCheckedChange={(value) =>
                  void setSetting("general.createCollectionSubfolder", value)
                }
              />
            }
          />
        </Section>

        <Section icon={<DownloadIcon className="size-3.5" />} title="다운로드 큐">
          <SettingRow
            title="세그먼트 풀 크기"
            description="앱 전체에서 공유하는 세그먼트 풀의 최대 크기입니다. 여러 파일·컬렉션에 고르게 나뉩니다."
            control={
              <NumberSetting
                value={settings["transfer.segmentPoolSize"]}
                min={SEGMENT_POOL_SIZE_MIN}
                max={SEGMENT_POOL_SIZE_MAX}
                onChange={(value) => void setSetting("transfer.segmentPoolSize", value)}
              />
            }
          />
          <SettingRow
            title="청크 재시도"
            description="청크 다운로드 실패 시 최대 재시도 횟수입니다."
            control={
              <Select
                items={chunkRetryOptions}
                value={String(settings["transfer.maxChunkRetries"])}
                onValueChange={(value) => {
                  if (value === null) return;
                  void setSetting("transfer.maxChunkRetries", Number.parseInt(value, 10));
                }}
              >
                <SelectTrigger className="w-34">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent finalFocus={false}>
                  <SelectGroup>
                    {chunkRetryOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
          <SettingRow
            title="스트림 쓰기 배치"
            description="스트림으로 받은 데이터를 디스크에 쓰기 전에 모으는 크기입니다."
            control={
              <Select
                items={streamWriteBatchOptions}
                value={String(settings["transfer.streamWriteBatchBytes"])}
                onValueChange={(value) => {
                  if (value === null) return;
                  void setSetting("transfer.streamWriteBatchBytes", Number.parseInt(value, 10));
                }}
              >
                <SelectTrigger className="w-34">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent finalFocus={false}>
                  <SelectGroup>
                    {streamWriteBatchOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
          <SettingRow
            title="시작 시 이어받기"
            description="앱 시작 시 이전 다운로드를 자동으로 다시 시작할지 선택합니다."
            control={
              <Select
                items={startupResumeModeOptions}
                value={settings["transfer.startupResumeMode"]}
                onValueChange={(value) => {
                  if (value === null) return;
                  void setSetting("transfer.startupResumeMode", value);
                }}
              >
                <SelectTrigger className="w-34">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent finalFocus={false}>
                  <SelectGroup>
                    {startupResumeModeOptions.map((mode) => (
                      <SelectItem key={mode.value} value={mode.value}>
                        {mode.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
        </Section>

        <Section icon={<UploadIcon className="size-3.5" />} title="업로드 큐">
          <SettingRow
            title="청크 재시도"
            description="청크 업로드 실패 시 최대 재시도 횟수입니다."
            control={
              <Select
                items={uploadChunkRetryOptions}
                value={String(settings["transfer.uploadMaxChunkRetries"])}
                onValueChange={(value) => {
                  if (value === null) return;
                  void setSetting("transfer.uploadMaxChunkRetries", Number.parseInt(value, 10));
                }}
              >
                <SelectTrigger className="w-34">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent finalFocus={false}>
                  <SelectGroup>
                    {uploadChunkRetryOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
          <SettingRow
            title="시작 시 이어받기"
            description="앱 시작 시 이전 업로드를 자동으로 다시 시작할지 선택합니다."
            control={
              <Select
                items={startupResumeModeOptions}
                value={settings["transfer.uploadStartupResumeMode"]}
                onValueChange={(value) => {
                  if (value === null) return;
                  void setSetting("transfer.uploadStartupResumeMode", value);
                }}
              >
                <SelectTrigger className="w-34">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent finalFocus={false}>
                  <SelectGroup>
                    {startupResumeModeOptions.map((mode) => (
                      <SelectItem key={mode.value} value={mode.value}>
                        {mode.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
        </Section>

        <Section icon={<CpuIcon className="size-3.5" />} title="고급">
          <SettingRow
            title="로그 레벨"
            description="앱 로그의 상세 정도를 설정합니다."
            control={
              <Select
                items={logLevelOptions}
                value={settings["general.logLevel"]}
                onValueChange={(value) => {
                  if (value === null) return;
                  void setSetting("general.logLevel", value);
                }}
              >
                <SelectTrigger className="w-34">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent finalFocus={false}>
                  <SelectGroup>
                    {logLevelOptions.map((level) => (
                      <SelectItem key={level.value} value={level.value}>
                        {level.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
        </Section>

        <Section icon={<MoonIcon className="size-3.5" />} title="외관">
          <SettingRow
            title="테마"
            description="앱의 색상 테마를 선택합니다."
            control={
              <Select
                items={themeOptions}
                value={settings["general.theme"]}
                onValueChange={(value) => {
                  if (value === null) return;
                  void setSetting("general.theme", value);
                }}
              >
                <SelectTrigger className="w-34">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent finalFocus={false}>
                  <SelectGroup>
                    {themeOptions.map((theme) => (
                      <SelectItem key={theme.value} value={theme.value}>
                        {theme.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
        </Section>
      </div>
    </ScrollArea>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 px-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      <div className="flex flex-col rounded-xl border bg-card">
        {React.Children.toArray(children).map((child, i, arr) => (
          <React.Fragment key={i}>
            {child}
            {i < arr.length - 1 && <Separator />}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label className="text-sm">{title}</Label>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function NumberSetting({
  value,
  onChange,
  min = 1,
  max,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={1}
      className="w-20 text-right tabular-nums"
      value={value}
      onChange={(event) => {
        const next = Number.parseInt(event.target.value, 10);
        if (Number.isFinite(next)) {
          onChange(Math.min(max ?? Infinity, Math.max(min, next)));
        }
      }}
    />
  );
}
