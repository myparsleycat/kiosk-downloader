import { Label } from "@renderer/components/ui/label";
import * as React from "react";

export function SectionTitle({ title }: { title: string }) {
  return (
    <h3 className="cn-font-heading px-1 pb-2 text-sm font-medium text-muted-foreground">{title}</h3>
  );
}

export function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col border-l border-foreground/20 pl-4">
      {React.Children.toArray(children).map((child, i) => (
        <React.Fragment key={i}>{child}</React.Fragment>
      ))}
    </div>
  );
}

export function SettingRow({
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
        <span className="text-xs wrap-anywhere text-muted-foreground">{description}</span>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
