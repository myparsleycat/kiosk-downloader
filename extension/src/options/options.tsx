import { ConnectionStatus } from "@ext/shared/connection-status";
import { useExtensionSettings } from "@ext/shared/hooks";
import {
  type ExtensionSettings,
  LINK_CLICK_ACTION_LABELS,
  LINK_CLICK_ACTIONS,
  LINK_PROVIDER_LABELS,
  LINK_PROVIDERS,
  parseHostListInput,
  parseListInput,
} from "@ext/shared/settings";
import { Section, SectionTitle, SettingRow } from "@renderer/components/settings/setting-layout";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import * as React from "react";

type LinkButtonSettings = ExtensionSettings["linkButtons"];
type InterceptSettings = ExtensionSettings["intercept"];

export function Options() {
  const { settings, update, error } = useExtensionSettings();

  if (!settings) {
    return null;
  }

  const updateLinkButtons = (patch: Partial<LinkButtonSettings>) =>
    update((current) => ({ ...current, linkButtons: { ...current.linkButtons, ...patch } }));
  const updateIntercept = (patch: Partial<InterceptSettings>) =>
    update((current) => ({ ...current, intercept: { ...current.intercept, ...patch } }));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
        <div className="flex items-center gap-2">
          <img src="/icons/icon-48.png" alt="" className="size-7" />
          <h1 className="text-base font-medium">kioex 설정</h1>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-col gap-1">
          <SectionTitle title="Kiosk Downloader 연결" />
          <Section>
            <ConnectionStatus className="p-3.5" />
          </Section>
        </div>

        <div className="flex flex-col gap-1">
          <SectionTitle title="링크 버튼" />
          <Section>
            <SettingRow
              title="링크 버튼 표시"
              description="지원하는 링크 옆에 다운로드 버튼을 표시합니다."
              control={
                <Switch
                  checked={settings.linkButtons.enabled}
                  onCheckedChange={(enabled) => updateLinkButtons({ enabled })}
                />
              }
            />
            <SettingRow
              title="버튼 클릭 동작"
              description={`${LINK_CLICK_ACTION_LABELS.send}: 앱의 새 다운로드 화면에서 확인 후 시작합니다.\n${LINK_CLICK_ACTION_LABELS.popover}: 페이지에서 고른 파일을 마지막 저장 위치에 다운로드합니다.`}
              control={
                <Select
                  items={LINK_CLICK_ACTIONS.map((value) => ({
                    value,
                    label: LINK_CLICK_ACTION_LABELS[value],
                  }))}
                  value={settings.linkButtons.clickAction}
                  disabled={!settings.linkButtons.enabled}
                  onValueChange={(clickAction) => {
                    if (clickAction !== null) updateLinkButtons({ clickAction });
                  }}
                >
                  <SelectTrigger className="w-52">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent finalFocus={false}>
                    <SelectGroup>
                      {LINK_CLICK_ACTIONS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {LINK_CLICK_ACTION_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              }
            />
            {LINK_PROVIDERS.map((provider) => (
              <SettingRow
                key={provider}
                title={LINK_PROVIDER_LABELS[provider]}
                description={
                  provider === "direct"
                    ? "아래 확장자의 파일 링크에 버튼을 표시합니다. 인코딩된 링크는 확장자와 무관합니다."
                    : `${LINK_PROVIDER_LABELS[provider]} 링크에 버튼을 표시합니다.`
                }
                control={
                  <Switch
                    checked={settings.linkButtons.providers[provider]}
                    disabled={!settings.linkButtons.enabled}
                    onCheckedChange={(enabled) =>
                      updateLinkButtons({
                        providers: { ...settings.linkButtons.providers, [provider]: enabled },
                      })
                    }
                  />
                }
              />
            ))}
            <ListSetting
              key={settings.linkButtons.directExtensions.join()}
              title="직접 링크 확장자"
              description="쉼표나 공백으로 구분합니다."
              placeholder="zip, 7z, mp4"
              value={settings.linkButtons.directExtensions}
              disabled={!settings.linkButtons.enabled || !settings.linkButtons.providers.direct}
              onChange={(directExtensions) => updateLinkButtons({ directExtensions })}
            />
            <SettingRow
              title="링크 안의 인코딩된 주소 해석"
              description="링크 주소 안에 base64로 인코딩된 링크를 찾습니다."
              control={
                <Switch
                  checked={settings.linkButtons.decodeLinks}
                  disabled={!settings.linkButtons.enabled}
                  onCheckedChange={(decodeLinks) => updateLinkButtons({ decodeLinks })}
                />
              }
            />
            <SettingRow
              title="본문의 base64 문자열 해석"
              description="본문의 base64 문자열이 지원하는 링크이면 버튼을 표시합니다."
              control={
                <Switch
                  checked={settings.linkButtons.decodeText}
                  disabled={!settings.linkButtons.enabled}
                  onCheckedChange={(decodeText) => updateLinkButtons({ decodeText })}
                />
              }
            />
          </Section>
        </div>

        <div className="flex flex-col gap-1">
          <SectionTitle title="다운로드 가로채기" />
          <Section>
            <SettingRow
              title="브라우저 다운로드 가로채기"
              description="브라우저 다운로드를 앱으로 보냅니다. 앱에 연결할 수 없으면 브라우저에서 다운로드합니다."
              control={
                <Switch
                  checked={settings.intercept.enabled}
                  onCheckedChange={(enabled) => updateIntercept({ enabled })}
                />
              }
            />
            <ListSetting
              key={settings.intercept.extensions.join()}
              title="대상 확장자"
              description="비워 두면 모든 파일을 가로챕니다."
              placeholder="zip, 7z, mp4"
              value={settings.intercept.extensions}
              disabled={!settings.intercept.enabled}
              onChange={(extensions) => updateIntercept({ extensions })}
            />
            <SettingRow
              title="최소 파일 크기 (MiB)"
              description="이보다 작은 파일은 가로채지 않습니다. 0이면 제한이 없습니다."
              control={
                <MinSizeInput
                  key={settings.intercept.minSizeMiB}
                  value={settings.intercept.minSizeMiB}
                  disabled={!settings.intercept.enabled}
                  onChange={(minSizeMiB) => updateIntercept({ minSizeMiB })}
                />
              }
            />
            <ListSetting
              key={settings.intercept.excludedHosts.join()}
              title="제외 사이트"
              description="파일 주소나 시작한 페이지가 이 도메인(하위 도메인 포함)이면 가로채지 않습니다. *는 임의의 문자열과 일치합니다."
              placeholder="example.com, *.example.org, cdn*.example.net"
              value={settings.intercept.excludedHosts}
              disabled={!settings.intercept.enabled}
              parse={parseHostListInput}
              onChange={(excludedHosts) => updateIntercept({ excludedHosts })}
            />
            <SettingRow
              title="앱이 꺼져 있으면 실행"
              description="앱이 실행 중이 아니면 실행한 뒤 보냅니다."
              control={
                <Switch
                  checked={settings.intercept.launchApp}
                  disabled={!settings.intercept.enabled}
                  onCheckedChange={(launchApp) => updateIntercept({ launchApp })}
                />
              }
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

function ListSetting({
  title,
  description,
  placeholder,
  value,
  disabled,
  parse = parseListInput,
  onChange,
}: {
  title: string;
  description: string;
  placeholder: string;
  value: string[];
  disabled?: boolean;
  parse?: (value: string) => string[];
  onChange: (value: string[]) => void;
}) {
  const [draft, setDraft] = React.useState(value.join(", "));

  return (
    <div className="flex flex-col gap-2 p-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label className="text-sm">{title}</Label>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <Input
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        className="h-8"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = parse(draft);
          setDraft(next.join(", "));
          onChange(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </div>
  );
}

function MinSizeInput({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = React.useState(String(value));

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <Input
      type="number"
      min={0}
      step={1}
      value={draft}
      disabled={disabled}
      className="h-8 w-24"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
