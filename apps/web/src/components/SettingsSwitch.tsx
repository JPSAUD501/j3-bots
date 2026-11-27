// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId } from "react";
import { Switch } from "./ui/switch";

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
