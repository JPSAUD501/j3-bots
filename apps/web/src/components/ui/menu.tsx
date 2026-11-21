// SPDX-License-Identifier: AGPL-3.0-or-later
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { touchTarget } from "../../lib/touchTarget";

/** A menu row: compact for a mouse, the full touch target on a touch screen. */
const item = cn(
  "flex h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none data-highlighted:bg-muted",
  touchTarget,
);

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

/** A menu row. `hint`, when given, says more on a quieter second line. */
export function MenuItem({
  onClick,
  children,
  hint,
}: {
  onClick: () => void;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <MenuPrimitive.Item
      onClick={onClick}
      className={cn(item, hint !== undefined && "h-auto flex-col items-start gap-0 py-1.5")}
    >
      {children}
      {hint !== undefined && <span className="max-w-56 text-xs text-muted-foreground">{hint}</span>}
    </MenuPrimitive.Item>
  );
}
