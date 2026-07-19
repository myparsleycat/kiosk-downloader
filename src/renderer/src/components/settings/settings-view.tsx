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
import { Button } from "@renderer/components/ui/button";
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
import { useUpdaterStore } from "@renderer/stores/updater";
import {
  type AppSettings,
  AUTO_UPDATE_MODES,
  type AutoUpdateMode,
  BANDWIDTH_LIMIT_MIBPS_DEFAULT,
  BANDWIDTH_LIMIT_MIBPS_MAX,
  BANDWIDTH_LIMIT_MIBPS_MIN,
  CHUNK_RETRY_DEFAULT,
  CHUNK_RETRY_MAX,
  CHUNK_RETRY_MIN,
  COLLECTION_PASSWORD_LIST_MAX,
  INFLATE_BUFFER_BYTES_DEFAULT,
  INFLATE_BUFFER_BYTES_OPTIONS,
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
  ArrowLeftRightIcon,
  ArrowUpCircleIcon,
  CpuIcon,
  DownloadIcon,
  FolderOpenIcon,
  LockIcon,
  MoonIcon,
  PlusIcon,
  PowerIcon,
  SettingsIcon,
  UploadIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

const SETTING_KEYS = [
  "general.runOnStartup",
  "general.runInBackground",
  "general.createCollectionSubfolder",
  "general.asciiFilenames",
  "general.powerSaveBlockInTransfer",
  "general.shutdownAfterTransfer",
  "general.autoUpdateMode",
  "general.autoTryCollectionPasswords",
  "general.collectionPasswordList",
  "general.logLevel",
  "general.theme",
  "transfer.segmentPoolSize",
  "transfer.maxChunkRetries",
  "transfer.uploadMaxChunkRetries",
  "transfer.streamWriteBatchBytes",
  "transfer.inflateBufferBytes",
  "transfer.startupResumeMode",
  "transfer.uploadStartupResumeMode",
  "transfer.downloadBandwidthLimitMibps",
  "transfer.uploadBandwidthLimitMibps",
] as const;

type SettingsState = {
  [K in (typeof SETTING_KEYS)[number]]: AppSettings[K];
};

const DEFAULT_SETTINGS: SettingsState = {
  "general.runOnStartup": false,
  "general.runInBackground": true,
  "general.createCollectionSubfolder": true,
  "general.asciiFilenames": false,
  "general.powerSaveBlockInTransfer": true,
  "general.shutdownAfterTransfer": false,
  "general.autoUpdateMode": "auto",
  "general.autoTryCollectionPasswords": false,
  "general.collectionPasswordList": [],
  "general.logLevel": "error",
  "general.theme": "system",
  "transfer.segmentPoolSize": SEGMENT_POOL_SIZE_DEFAULT,
  "transfer.maxChunkRetries": CHUNK_RETRY_DEFAULT,
  "transfer.uploadMaxChunkRetries": UPLOAD_CHUNK_RETRY_DEFAULT,
  "transfer.streamWriteBatchBytes": STREAM_WRITE_BATCH_BYTES_DEFAULT,
  "transfer.inflateBufferBytes": INFLATE_BUFFER_BYTES_DEFAULT,
  "transfer.startupResumeMode": "auto",
  "transfer.uploadStartupResumeMode": "auto",
  "transfer.downloadBandwidthLimitMibps": BANDWIDTH_LIMIT_MIBPS_DEFAULT,
  "transfer.uploadBandwidthLimitMibps": BANDWIDTH_LIMIT_MIBPS_DEFAULT,
};

const chunkRetryOptions = rangeOptions(CHUNK_RETRY_MIN, CHUNK_RETRY_MAX);
const uploadChunkRetryOptions = rangeOptions(UPLOAD_CHUNK_RETRY_MIN, UPLOAD_CHUNK_RETRY_MAX);
const streamWriteBatchOptions = byteOptions(STREAM_WRITE_BATCH_BYTES_OPTIONS);
const inflateBufferOptions = byteOptions(INFLATE_BUFFER_BYTES_OPTIONS);

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

const autoUpdateModeLabels: Record<AutoUpdateMode, string> = {
  auto: "자동",
  notify: "알림만",
  off: "끔",
};

const autoUpdateModeDescriptions: Record<AutoUpdateMode, string> = {
  auto: "업데이트를 자동으로 확인하고 다운로드합니다. 설치는 확인 후 진행됩니다.",
  notify: "업데이트가 있으면 알림만 표시하고, 다운로드는 직접 시작합니다.",
  off: "자동 확인을 하지 않습니다. 수동으로 확인할 수 있습니다.",
};

const autoUpdateModeOptions = AUTO_UPDATE_MODES.map((value) => ({
  value,
  label: autoUpdateModeLabels[value],
}));

function getUpdaterStatusText(options: {
  strategy: string;
  mode: AutoUpdateMode;
  isChecking: boolean;
  isDownloading: boolean;
  updateDownloaded: boolean;
  updateAvailable: boolean;
  releaseVersion: string | null;
}) {
  if (options.strategy === "unsupported") {
    return "이 빌드에서는 자동 업데이트를 지원하지 않습니다.";
  }
  if (options.mode === "off") {
    return "자동 업데이트가 꺼져 있습니다.";
  }
  if (options.isChecking) {
    return "업데이트 확인 중…";
  }
  if (options.isDownloading) {
    return "업데이트 다운로드 중…";
  }
  if (options.updateDownloaded && options.releaseVersion) {
    return `v${options.releaseVersion} 설치 준비 완료`;
  }
  if (options.updateAvailable && options.releaseVersion) {
    return options.strategy === "manual"
      ? `v${options.releaseVersion} 사용 가능 (수동 다운로드)`
      : `v${options.releaseVersion} 사용 가능`;
  }
  return "최신 버전입니다.";
}

export function SettingsView() {
  const [settings, setSettings] = React.useState<SettingsState>(DEFAULT_SETTINGS);
  const [appStatus, setAppStatus] = React.useState<AppStatus | null>(null);
  const [shutdownConfirmOpen, setShutdownConfirmOpen] = React.useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = React.useState(false);
  const [isUpdateActionPending, setIsUpdateActionPending] = React.useState(false);

  const updaterStrategy = useUpdaterStore((state) => state.strategy);
  const updaterMode = useUpdaterStore((state) => state.mode);
  const updateAvailable = useUpdaterStore((state) => state.updateAvailable);
  const updateDownloaded = useUpdaterStore((state) => state.updateDownloaded);
  const releaseVersion = useUpdaterStore((state) => state.releaseVersion);
  const isChecking = useUpdaterStore((state) => state.isChecking);
  const isDownloading = useUpdaterStore((state) => state.isDownloading);
  const setShouldPromptForUpdate = useUpdaterStore((state) => state.setShouldPromptForUpdate);

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
      <AlertDialog open={shutdownConfirmOpen} onOpenChange={setShutdownConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>전송 완료 후 시스템 종료</AlertDialogTitle>
            <AlertDialogDescription>
              업로드·다운로드가 모두 끝나면 PC가 자동으로 종료됩니다. 저장하지 않은 작업이 남아 있지
              않은지 확인한 뒤 켜 주세요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShutdownConfirmOpen(false);
                void setSetting("general.shutdownAfterTransfer", true);
              }}
            >
              켜기
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

        <Section icon={<ArrowUpCircleIcon className="size-3.5" />} title="업데이트">
          <SettingRow
            title="현재 버전"
            description={
              appStatus
                ? `v${appStatus.version}${appStatus.isPortable ? " (portable)" : ""}${appStatus.isDev ? " · dev" : ""}`
                : "버전 정보를 불러오는 중…"
            }
            control={
              updaterStrategy !== "unsupported" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  isLoading={isCheckingUpdate || isChecking}
                  onClick={() => {
                    setIsCheckingUpdate(true);
                    void window.api
                      .invoke("updater:checkForUpdates")
                      .then(async () => {
                        const status = await window.api.invoke("updater:getStatus");
                        if (!status.updateAvailable && !status.updateDownloaded) {
                          toast.success("최신 버전입니다");
                        }
                      })
                      .catch((error) => {
                        toast.error("업데이트를 확인하지 못했습니다", {
                          description: error instanceof Error ? error.message : String(error),
                        });
                      })
                      .finally(() => setIsCheckingUpdate(false));
                  }}
                >
                  지금 확인
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void window.api.invoke("updater:openDownloadPage")}
                >
                  릴리스 열기
                </Button>
              )
            }
          />
          {updaterStrategy !== "unsupported" && (
            <SettingRow
              title="자동 업데이트"
              description={autoUpdateModeDescriptions[settings["general.autoUpdateMode"]]}
              control={
                <SettingSelect
                  options={autoUpdateModeOptions}
                  value={settings["general.autoUpdateMode"]}
                  onChange={(value) => void setSetting("general.autoUpdateMode", value)}
                />
              }
            />
          )}
          <SettingRow
            title="상태"
            description={getUpdaterStatusText({
              strategy: updaterStrategy,
              mode: settings["general.autoUpdateMode"],
              isChecking,
              isDownloading,
              updateDownloaded,
              updateAvailable,
              releaseVersion,
            })}
            control={
              updaterStrategy === "nsis" &&
              updateAvailable &&
              !updateDownloaded &&
              (updaterMode === "notify" || settings["general.autoUpdateMode"] === "notify") ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  isLoading={isUpdateActionPending || isDownloading}
                  onClick={() => {
                    setIsUpdateActionPending(true);
                    void window.api
                      .invoke("updater:downloadUpdate")
                      .catch((error) => {
                        toast.error("업데이트를 다운로드하지 못했습니다", {
                          description: error instanceof Error ? error.message : String(error),
                        });
                      })
                      .finally(() => setIsUpdateActionPending(false));
                  }}
                >
                  다운로드
                </Button>
              ) : updaterStrategy === "nsis" && updateDownloaded ? (
                <Button type="button" size="sm" onClick={() => setShouldPromptForUpdate(true)}>
                  설치
                </Button>
              ) : updaterStrategy === "manual" && updateAvailable ? (
                <Button type="button" size="sm" onClick={() => setShouldPromptForUpdate(true)}>
                  확인
                </Button>
              ) : null
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
          <SettingRow
            title="전송 완료 후 시스템 종료"
            description="업로드·다운로드가 모두 끝나면 기기를 종료합니다."
            control={
              <Switch
                checked={settings["general.shutdownAfterTransfer"]}
                onCheckedChange={(value) => {
                  if (value) {
                    setShutdownConfirmOpen(true);
                    return;
                  }
                  void setSetting("general.shutdownAfterTransfer", false);
                }}
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
          <SettingRow
            title="ASCII 파일명으로 저장"
            description="다운로드 파일·폴더 이름에서 비ASCII 문자를 유사 ASCII 또는 _로 바꿉니다. 새로 시작하는 다운로드에만 적용됩니다."
            control={
              <Switch
                checked={settings["general.asciiFilenames"]}
                onCheckedChange={(value) => void setSetting("general.asciiFilenames", value)}
              />
            }
          />
        </Section>

        <Section icon={<LockIcon className="size-3.5" />} title="컬렉션 비밀번호">
          <SettingRow
            title="비밀번호 자동 시도"
            description="보호된 컬렉션 로드 시 등록된 비밀번호를 병렬로 시도합니다."
            control={
              <Switch
                checked={settings["general.autoTryCollectionPasswords"]}
                onCheckedChange={(value) =>
                  void setSetting("general.autoTryCollectionPasswords", value)
                }
              />
            }
          />
          <CollectionPasswordListSetting
            value={settings["general.collectionPasswordList"]}
            onChange={(value) => void setSetting("general.collectionPasswordList", value)}
          />
        </Section>

        <Section icon={<ArrowLeftRightIcon className="size-3.5" />} title="전송 큐">
          <SettingRow
            title="세그먼트 풀 크기"
            description="다운로드·업로드가 공유하는 세그먼트 풀의 최대 크기입니다. 업로드 동시 세그먼트는 별도 제한이 적용됩니다."
            control={
              <NumberSetting
                value={settings["transfer.segmentPoolSize"]}
                min={SEGMENT_POOL_SIZE_MIN}
                max={SEGMENT_POOL_SIZE_MAX}
                onChange={(value) => void setSetting("transfer.segmentPoolSize", value)}
              />
            }
          />
        </Section>

        <Section icon={<DownloadIcon className="size-3.5" />} title="다운로드 큐">
          <SettingRow
            title="대역폭 제한"
            description="다운로드 합산 속도 상한입니다. 0이면 무제한입니다."
            control={
              <div className="flex items-center gap-2">
                <NumberSetting
                  value={settings["transfer.downloadBandwidthLimitMibps"]}
                  min={BANDWIDTH_LIMIT_MIBPS_MIN}
                  max={BANDWIDTH_LIMIT_MIBPS_MAX}
                  onChange={(value) =>
                    void setSetting("transfer.downloadBandwidthLimitMibps", value)
                  }
                />
                <span className="text-xs text-muted-foreground tabular-nums">MiB/s</span>
              </div>
            }
          />
          <SettingRow
            title="청크 재시도"
            description="청크 다운로드 실패 시 최대 재시도 횟수입니다."
            control={
              <SettingSelect
                options={chunkRetryOptions}
                value={String(settings["transfer.maxChunkRetries"])}
                onChange={(value) =>
                  void setSetting("transfer.maxChunkRetries", Number.parseInt(value, 10))
                }
              />
            }
          />
          <SettingRow
            title="스트림 쓰기 배치"
            description="스트림으로 받은 데이터를 디스크에 쓰기 전에 모으는 크기입니다."
            control={
              <SettingSelect
                options={streamWriteBatchOptions}
                value={String(settings["transfer.streamWriteBatchBytes"])}
                onChange={(value) =>
                  void setSetting("transfer.streamWriteBatchBytes", Number.parseInt(value, 10))
                }
              />
            }
          />
          <SettingRow
            title="압축 해제 배치"
            description="Deflate ZIP 항목을 압축 해제할 때 사용하는 버퍼 크기입니다."
            control={
              <SettingSelect
                options={inflateBufferOptions}
                value={String(settings["transfer.inflateBufferBytes"])}
                onChange={(value) =>
                  void setSetting("transfer.inflateBufferBytes", Number.parseInt(value, 10))
                }
              />
            }
          />
          <SettingRow
            title="시작 시 이어받기"
            description="앱 시작 시 이전 다운로드를 자동으로 다시 시작할지 선택합니다."
            control={
              <SettingSelect
                options={startupResumeModeOptions}
                value={settings["transfer.startupResumeMode"]}
                onChange={(value) => void setSetting("transfer.startupResumeMode", value)}
              />
            }
          />
        </Section>

        <Section icon={<UploadIcon className="size-3.5" />} title="업로드 큐">
          <SettingRow
            title="대역폭 제한"
            description="업로드 합산 속도 상한입니다. 0이면 무제한입니다."
            control={
              <div className="flex items-center gap-2">
                <NumberSetting
                  value={settings["transfer.uploadBandwidthLimitMibps"]}
                  min={BANDWIDTH_LIMIT_MIBPS_MIN}
                  max={BANDWIDTH_LIMIT_MIBPS_MAX}
                  onChange={(value) => void setSetting("transfer.uploadBandwidthLimitMibps", value)}
                />
                <span className="text-xs text-muted-foreground tabular-nums">MiB/s</span>
              </div>
            }
          />
          <SettingRow
            title="청크 재시도"
            description="청크 업로드 실패 시 최대 재시도 횟수입니다."
            control={
              <SettingSelect
                options={uploadChunkRetryOptions}
                value={String(settings["transfer.uploadMaxChunkRetries"])}
                onChange={(value) =>
                  void setSetting("transfer.uploadMaxChunkRetries", Number.parseInt(value, 10))
                }
              />
            }
          />
          <SettingRow
            title="시작 시 이어받기"
            description="앱 시작 시 이전 업로드를 자동으로 다시 시작할지 선택합니다."
            control={
              <SettingSelect
                options={startupResumeModeOptions}
                value={settings["transfer.uploadStartupResumeMode"]}
                onChange={(value) => void setSetting("transfer.uploadStartupResumeMode", value)}
              />
            }
          />
        </Section>

        <Section icon={<CpuIcon className="size-3.5" />} title="고급">
          <SettingRow
            title="로그 레벨"
            description="앱 로그의 상세 정도를 설정합니다."
            control={
              <SettingSelect
                options={logLevelOptions}
                value={settings["general.logLevel"]}
                onChange={(value) => void setSetting("general.logLevel", value)}
              />
            }
          />
        </Section>

        <Section icon={<MoonIcon className="size-3.5" />} title="외관">
          <SettingRow
            title="테마"
            description="앱의 색상 테마를 선택합니다."
            control={
              <SettingSelect
                options={themeOptions}
                value={settings["general.theme"]}
                onChange={(value) => void setSetting("general.theme", value)}
              />
            }
          />
        </Section>
      </div>
    </ScrollArea>
  );
}

function rangeOptions(min: number, max: number) {
  return Array.from({ length: max - min + 1 }, (_, index) => {
    const value = String(min + index);
    return { value, label: value };
  });
}

function byteOptions(values: readonly number[]) {
  return values.map((value) => ({ value: String(value), label: formatSize(value) }));
}

function SettingSelect<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue !== null) onChange(nextValue);
      }}
    >
      <SelectTrigger className="w-34">
        <SelectValue />
      </SelectTrigger>
      <SelectContent finalFocus={false}>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
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

type PasswordRow = { id: string; value: string };

function createPasswordRow(value = ""): PasswordRow {
  return { id: crypto.randomUUID(), value };
}

function CollectionPasswordListSetting({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [items, setItems] = React.useState<PasswordRow[]>(() =>
    value.map((entry) => createPasswordRow(entry)),
  );
  const itemsRef = React.useRef(items);
  const isFocusedRef = React.useRef(false);

  React.useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  React.useEffect(() => {
    if (isFocusedRef.current) {
      return;
    }

    setItems((prev) => {
      if (
        prev.length === value.length &&
        prev.every((item, index) => item.value === value[index])
      ) {
        return prev;
      }

      return value.map((entry, index) =>
        prev[index]?.value === entry
          ? prev[index]
          : { id: prev[index]?.id ?? crypto.randomUUID(), value: entry },
      );
    });
  }, [value]);

  const updateItems = (next: PasswordRow[]) => {
    itemsRef.current = next;
    setItems(next);
  };

  const commit = (next: PasswordRow[]) => {
    updateItems(next);
    onChange(next.map((item) => item.value));
  };

  return (
    <div className="flex flex-col gap-2 p-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label className="text-sm">자동 시도 비밀번호</Label>
        <span className="text-xs text-muted-foreground">
          최대 {COLLECTION_PASSWORD_LIST_MAX}개까지 저장·표시됩니다.
        </span>
      </div>
      <div
        className="flex flex-col gap-1.5"
        onFocus={() => {
          isFocusedRef.current = true;
        }}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          ) {
            return;
          }
          isFocusedRef.current = false;
          onChange(itemsRef.current.map((row) => row.value));
        }}
      >
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-1.5">
            <Input
              value={item.value}
              placeholder="비밀번호"
              className="h-8"
              onChange={(event) => {
                updateItems(
                  itemsRef.current.map((row) =>
                    row.id === item.id ? { ...row, value: event.target.value } : row,
                  ),
                );
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={() => commit(itemsRef.current.filter((row) => row.id !== item.id))}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={items.length >= COLLECTION_PASSWORD_LIST_MAX}
          onClick={() => {
            if (itemsRef.current.length >= COLLECTION_PASSWORD_LIST_MAX) {
              return;
            }
            updateItems([...itemsRef.current, createPasswordRow()]);
          }}
        >
          <PlusIcon className="size-3.5" />
          추가
        </Button>
      </div>
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
