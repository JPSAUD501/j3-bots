// SPDX-License-Identifier: AGPL-3.0-or-later
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

export function Switch(props: Omit<SwitchPrimitive.Root.Props, "className">) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className="relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-pill p-0.5 transition-colors duration-(--duration-state) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent data-checked:bg-control-on data-unchecked:bg-control-off data-disabled:cursor-not-allowed data-disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-3"
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 rounded-pill bg-control-thumb shadow-thumb transition-transform duration-(--duration-pop) ease-pop data-checked:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}
