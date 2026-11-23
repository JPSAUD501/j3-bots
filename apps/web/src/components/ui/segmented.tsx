// SPDX-License-Identifier: AGPL-3.0-or-later
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { cn } from "../../lib/cn";

/**
 * A few choices side by side in one pill, one of them picked: the picked one
 * is a raised `surface` segment, the others quiet text on `muted`. A radio
 * group for assistive technology, moved through with the arrow keys. For two to
 * four short choices; more, or long ones, belong in a list.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  labelledBy,
  disabled = false,
}: {
  value: T;
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  onChange: (value: T) => void;
  /** The id of the label that names the group. */
  labelledBy: string;
  /** Shown, and not changed, while what it picks cannot change. */
  disabled?: boolean;
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={onChange}
      aria-labelledby={labelledBy}
      disabled={disabled}
      className="flex w-full gap-1 rounded-pill bg-muted p-1"
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className={cn(
            "pressable flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center truncate rounded-pill px-3 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent pointer-coarse:h-11",
            "data-checked:bg-surface data-checked:text-foreground data-checked:shadow-raised",
            "data-disabled:cursor-default data-disabled:opacity-60 data-disabled:hover:text-muted-foreground",
          )}
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
