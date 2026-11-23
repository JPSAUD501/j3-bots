// SPDX-License-Identifier: AGPL-3.0-or-later
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon } from "lucide-react";

/** A checkbox. Wrap it and its text in a `<label>`. */
export function Checkbox(props: Omit<CheckboxPrimitive.Root.Props, "className">) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className="relative flex size-4 shrink-0 items-center justify-center rounded-sm border border-control-off text-background transition-[background-color,border-color,scale] duration-(--duration-pop) ease-pop active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent data-checked:border-foreground data-checked:bg-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5"
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <CheckIcon className="size-3" strokeWidth={3} aria-hidden />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
