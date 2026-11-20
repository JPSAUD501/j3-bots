// SPDX-License-Identifier: AGPL-3.0-or-later
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;

export function MenuPopup({
  children,
  side = "top",
  align = "start",
}: {
  children: ReactNode;
  side?: MenuPrimitive.Positioner.Props["side"];
  align?: MenuPrimitive.Positioner.Props["align"];
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side={side} align={align} sideOffset={6} className="z-50">
        <MenuPrimitive.Popup
          data-slot="menu-popup"
          className="min-w-48 origin-(--transform-origin) rounded-lg border border-border bg-surface p-1 text-sm shadow-lg outline-none transition-[opacity,scale] duration-(--duration-fast) data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <MenuPrimitive.Group>
      <MenuPrimitive.GroupLabel className="px-2 pt-1.5 pb-1 text-2xs text-muted-foreground">
        {label}
      </MenuPrimitive.GroupLabel>
      {children}
    </MenuPrimitive.Group>
  );
}

export function MenuRadioGroup<V extends string>({
  value,
  onValueChange,
  options,
}: {
  value: V;
  onValueChange: (value: V) => void;
  options: ReadonlyArray<{ readonly value: V; readonly label: string }>;
}) {
  return (
    <MenuPrimitive.RadioGroup
      value={value}
      onValueChange={(next: unknown) => {
        const option = options.find((o) => o.value === next);
        if (option) onValueChange(option.value);
      }}
    >
      {options.map((option) => (
        <MenuPrimitive.RadioItem
          key={option.value}
          value={option.value}
          closeOnClick
          className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none data-highlighted:bg-muted"
        >
          <span className="flex size-4 items-center justify-center">
            <MenuPrimitive.RadioItemIndicator>
              <CheckIcon className="size-3.5" />
            </MenuPrimitive.RadioItemIndicator>
          </span>
          {option.label}
        </MenuPrimitive.RadioItem>
      ))}
    </MenuPrimitive.RadioGroup>
  );
}

export const MenuSeparator = () => <MenuPrimitive.Separator className="my-1 h-px bg-border" />;
