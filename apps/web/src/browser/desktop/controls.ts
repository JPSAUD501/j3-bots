// SPDX-License-Identifier: AGPL-3.0-or-later

// The looks the browser's bar shares among its buttons and their popups.

/** A round button of the bar. */
export const control =
  "pressable-round inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4";

/** What opens from the bar: a menu, a list, the suggestions. */
export const popup =
  "origin-(--transform-origin) rounded-lg border border-border bg-surface p-1.5 text-sm text-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-90 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-out";

/** A shortcut, as the system writes it. */
export const keys = (mac: boolean, ...parts: ReadonlyArray<string>) =>
  parts.map((part) => (part === "Ctrl" && mac ? "⌘" : part)).join(mac ? "" : "+");
