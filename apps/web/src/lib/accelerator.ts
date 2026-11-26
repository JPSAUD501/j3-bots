// SPDX-License-Identifier: AGPL-3.0-or-later
import { Accelerator } from "@j3-bots/desktop-bridge";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The desktop app's global shortcut as the operator presses it and reads it.

/** A key press, as much of a `KeyboardEvent` as a shortcut is made of. */
export interface KeyPress {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/**
 * What a key press makes: a shortcut; `incomplete`, a modifier alone, while
 * the operator is still pressing one; or `refused`, a key a shortcut cannot
 * have, or modifiers it cannot (`Accelerator`): none of Ctrl, Alt, Super or,
 * on a Mac, ⌘, or only one modifier, as every other app's own shortcuts.
 */
export type Pressed =
  | { readonly _tag: "shortcut"; readonly accelerator: Accelerator }
  | { readonly _tag: "incomplete" }
  | { readonly _tag: "refused" };

const MODIFIER_CODES = /^(?:Shift|Control|Alt|Meta|OS)(?:Left|Right)?$/;
const decodeAccelerator = Schema.decodeUnknownOption(Accelerator);

/** The key itself, by where it is on the keyboard, as an accelerator names it. */
const keyOf = (code: string): string | null => {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return letter;
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit !== undefined) return digit;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code) || code === "Space") return code;
  return null;
};

/**
 * The shortcut `press` makes. On a Mac, ⌘ is `CommandOrControl` and ⌃ is
 * `Control`; elsewhere Ctrl is `CommandOrControl` and the system key `Super`.
 */
export function pressedShortcut(press: KeyPress, mac: boolean): Pressed {
  if (MODIFIER_CODES.test(press.code)) return { _tag: "incomplete" };
  const key = keyOf(press.code);
  if (key === null) return { _tag: "refused" };
  const modifiers = [
    (mac ? press.metaKey : press.ctrlKey) && "CommandOrControl",
    mac && press.ctrlKey && "Control",
    press.altKey && "Alt",
    !mac && press.metaKey && "Super",
    press.shiftKey && "Shift",
  ].filter((modifier) => modifier !== false);
  return Option.match(decodeAccelerator([...modifiers, key].join("+")), {
    onNone: (): Pressed => ({ _tag: "refused" }),
    onSome: (accelerator): Pressed => ({ _tag: "shortcut", accelerator }),
  });
}

const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  CommandOrControl: "⌘",
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};
const OTHER_NAMES: Readonly<Record<string, string>> = {
  CommandOrControl: "Ctrl",
  Control: "Ctrl",
};

/** `accelerator` as the platform writes a shortcut: `⌃⌥⇧⌘J` on a Mac, `Ctrl+Shift+J` elsewhere. */
export function shortcutLabel(accelerator: Accelerator, mac: boolean): string {
  const parts = accelerator.split("+");
  if (!mac) return parts.map((part) => OTHER_NAMES[part] ?? part).join("+");
  const key = parts.at(-1) ?? "";
  // A Mac lists ⌃ ⌥ ⇧ ⌘ in that order, then the key.
  const order = ["Control", "Alt", "Shift", "CommandOrControl"];
  const symbols = order.filter((name) => parts.includes(name)).map((name) => MAC_SYMBOLS[name]);
  return `${symbols.join("")}${key}`;
}
