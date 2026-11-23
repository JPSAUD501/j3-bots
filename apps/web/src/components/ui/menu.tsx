// SPDX-License-Identifier: AGPL-3.0-or-later
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { touchTarget } from "../../lib/touchTarget";

/** A menu row: compact for a mouse, the full touch target on a touch screen. */
const item = cn(
  "flex h-9 cursor-default items-center gap-2 rounded-md px-2.5 outline-none transition-colors duration-(--duration-fast) data-highlighted:bg-muted",
  touchTarget,
);

const popup =
  "min-w-48 origin-(--transform-origin) rounded-lg border border-border bg-surface p-1.5 text-sm shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-90 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-out";

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;

/** Opens its menu where the operator right-clicks, or long-presses on a touch screen. */
export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

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
        <MenuPrimitive.Popup data-slot="menu-popup" className={popup}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** A context menu's popup, at the pointer. Its rows are the same `MenuItem`s. */
export function ContextMenuPopup({ children }: { children: ReactNode }) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-50">
        <ContextMenuPrimitive.Popup data-slot="menu-popup" className={popup}>
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

const leading = (icon: ReactNode, hint: boolean) => (
  <span
    aria-hidden
    className={cn("flex shrink-0 text-muted-foreground [&_svg]:size-4", hint && "pt-0.5")}
  >
    {icon}
  </span>
);

/**
 * A menu row. `icon`, when given, leads it in the quiet text color; `hint`
 * says more on a quieter second line. `checked` marks the row that is
 * already so, as the section a bot is in; `destructive` one that removes.
 */
export function MenuItem({
  onClick,
  children,
  hint,
  icon,
  checked,
  destructive = false,
}: {
  onClick: () => void;
  children: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  checked?: boolean;
  destructive?: boolean;
}) {
  return (
    <MenuPrimitive.Item
      onClick={onClick}
      className={cn(
        item,
        hint !== undefined && "h-auto items-start py-1.5",
        destructive && "text-blocked [&_[aria-hidden]]:text-blocked",
      )}
    >
      {icon !== undefined && leading(icon, hint !== undefined)}
      <span className="flex min-w-0 flex-1 flex-col">
        {children}
        {hint !== undefined && (
          <span className="max-w-56 text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
      {checked === true && <CheckIcon aria-hidden className="size-4 shrink-0" />}
    </MenuPrimitive.Item>
  );
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="mx-1 my-1 h-px bg-border" />;
}

/** A row that opens a menu of its own beside it: on hover, the right arrow or a press. */
export function MenuSubmenu({
  label,
  icon,
  children,
}: {
  label: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <MenuPrimitive.SubmenuRoot>
      <MenuPrimitive.SubmenuTrigger className={cn(item, "data-popup-open:bg-muted")}>
        {icon !== undefined && leading(icon, false)}
        <span className="min-w-0 flex-1">{label}</span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </MenuPrimitive.SubmenuTrigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner side="right" align="start" sideOffset={4} className="z-50">
          <MenuPrimitive.Popup className={popup}>{children}</MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.SubmenuRoot>
  );
}
