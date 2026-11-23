// SPDX-License-Identifier: AGPL-3.0-or-later
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { touchTarget } from "../../lib/touchTarget";

/** A menu row: compact for a mouse, the full touch target on a touch screen. */
const item = cn(
  "flex h-9 cursor-default items-center gap-2 rounded-md px-2.5 outline-none transition-colors duration-(--duration-fast) data-highlighted:bg-muted",
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
          className="min-w-48 origin-(--transform-origin) rounded-lg border border-border bg-surface p-1.5 text-sm shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-90 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-out"
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/**
 * A menu row. `icon`, when given, leads it in the quiet text color; `hint`
 * says more on a quieter second line.
 */
export function MenuItem({
  onClick,
  children,
  hint,
  icon,
}: {
  onClick: () => void;
  children: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <MenuPrimitive.Item
      onClick={onClick}
      className={cn(item, hint !== undefined && "h-auto items-start py-1.5")}
    >
      {icon !== undefined && (
        <span
          aria-hidden
          className={cn(
            "flex shrink-0 text-muted-foreground [&_svg]:size-4",
            hint !== undefined && "pt-0.5",
          )}
        >
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        {children}
        {hint !== undefined && (
          <span className="max-w-56 text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
    </MenuPrimitive.Item>
  );
}
