// SPDX-License-Identifier: AGPL-3.0-or-later
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

export function Switch(props: Omit<SwitchPrimitive.Root.Props, "className">) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className="relative inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-pill p-0.5 transition-colors duration-(--duration-state) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent data-checked:bg-foreground data-unchecked:bg-control-off data-disabled:cursor-not-allowed data-disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-3"
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 rounded-pill bg-background shadow-sm transition-transform duration-(--duration-state) ease-standard data-checked:translate-x-3" />
    </SwitchPrimitive.Root>
  );
}
