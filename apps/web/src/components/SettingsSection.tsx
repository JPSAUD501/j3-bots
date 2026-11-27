// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode, useId } from "react";
import { cn } from "../lib/cn";
import { Switch } from "./ui/switch";

/**
 * A group of settings on a page of Settings, set apart from the next by space,
 * under a quiet heading when the page's own title does not name it. An
 * `apart` group, one whose action cannot be undone, is ruled off below the rest.
 */
export function Section({
  title,
  apart = false,
  children,
}: {
  title?: string;
  apart?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-3", apart && "border-t border-border pt-6")}>
      {title !== undefined && (
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      )}
      {children}
    </section>
  );
}

/** A setting that is on or off: its name and what it does, beside the switch. */
export function SwitchRow({
  label,
  hint,
  checked,
  readOnly,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  readOnly: boolean;
  onChange: (checked: boolean) => void;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex items-start gap-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={labelId} className="text-sm">
          {label}
        </span>
        <span id={hintId} className="text-2xs text-muted-foreground">
          {hint}
        </span>
      </span>
      <Switch
        checked={checked}
        readOnly={readOnly}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onCheckedChange={onChange}
      />
    </div>
  );
}
