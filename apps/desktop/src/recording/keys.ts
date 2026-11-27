// SPDX-License-Identifier: AGPL-3.0-or-later

// The keys a recording reads, by the codes the input hook gives
// (libuiohook's `VC_*`, the keyboard's scan codes). The hook says which key
// was pressed, not which character the keyboard's layout made of it, so a
// character is the one a US keyboard makes there: letters, digits and the
// space are right on most layouts, punctuation may not be, and the video
// shows what was really typed. The README says so.

/** A key that types: what it makes alone, and with Shift. */
interface Typing {
  readonly plain: string;
  readonly shifted: string;
}

const row = (codes: ReadonlyArray<number>, plain: string, shifted: string) =>
  codes.map((code, index): readonly [number, Typing] => [
    code,
    { plain: plain.charAt(index), shifted: shifted.charAt(index) },
  ]);

const range = (from: number, count: number) => Array.from({ length: count }, (_, at) => from + at);

const TYPING: ReadonlyMap<number, Typing> = new Map([
  ...row(range(0x02, 12), "1234567890-=", "!@#$%^&*()_+"),
  ...row(range(0x10, 12), "qwertyuiop[]", "QWERTYUIOP{}"),
  ...row(range(0x1e, 12), "asdfghjkl;'`", 'ASDFGHJKL:"~'),
  ...row([0x2b], "\\", "|"),
  ...row(range(0x2c, 10), "zxcvbnm,./", "ZXCVBNM<>?"),
  ...row([0x39], " ", " "),
  // The keypad, as it types with Num Lock on.
  ...row([0x47, 0x48, 0x49, 0x4b, 0x4c, 0x4d, 0x4f, 0x50, 0x51, 0x52], "7894561230", "7894561230"),
  ...row([0x37, 0x4a, 0x4e, 0x53, 0x0e35], "*-+./", "*-+./"),
]);

/** Keys that do something rather than type, by the name the events give them. */
const NAMED: ReadonlyMap<number, string> = new Map([
  [0x01, "Escape"],
  [0x0e, "Backspace"],
  [0x0f, "Tab"],
  [0x1c, "Enter"],
  [0x0e1c, "Enter"],
  [0x3a, "CapsLock"],
  ...range(0x3b, 10).map((code, at): readonly [number, string] => [code, `F${at + 1}`]),
  [0x57, "F11"],
  [0x58, "F12"],
  [0x0e47, "Home"],
  [0x0e4f, "End"],
  [0x0e49, "PageUp"],
  [0x0e51, "PageDown"],
  [0x0e52, "Insert"],
  [0x0e53, "Delete"],
  [0xe048, "ArrowUp"],
  [0xe050, "ArrowDown"],
  [0xe04b, "ArrowLeft"],
  [0xe04d, "ArrowRight"],
  [0x0e37, "PrintScreen"],
  [0x0e5d, "ContextMenu"],
]);

/** Shift, Ctrl, Alt and the system key on either side, Num Lock and Scroll Lock: they type nothing alone. */
const MODIFIERS: ReadonlySet<number> = new Set([
  0x2a, 0x36, 0x1d, 0x0e1d, 0x38, 0x0e38, 0x0e5b, 0x0e5c, 0x45, 0x46,
]);

export interface KeyDown {
  readonly code: number;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

/**
 * What a key pressed means for a recording: a character it typed, a named
 * key, a shortcut (with Ctrl, Alt or the system key held), or nothing, for a
 * modifier alone or a key the table does not know.
 */
export type KeyMeaning =
  | { readonly _tag: "char"; readonly char: string }
  | { readonly _tag: "named"; readonly name: string }
  | { readonly _tag: "shortcut"; readonly keys: string }
  | { readonly _tag: "none" };

/** What the system key is called where the recording is made. */
export type System = "mac" | "windows" | "linux";

const keyName = (code: number): string | null => {
  const named = NAMED.get(code);
  if (named !== undefined) return named;
  const typing = TYPING.get(code);
  if (typing === undefined) return null;
  return typing.plain === " " ? "Space" : typing.plain.toUpperCase();
};

export const meaningOf = (key: KeyDown, system: System): KeyMeaning => {
  if (MODIFIERS.has(key.code)) return { _tag: "none" };
  if (key.ctrl || key.alt || key.meta) {
    const name = keyName(key.code);
    if (name === null) return { _tag: "none" };
    const held = [
      key.ctrl ? "Ctrl" : null,
      key.alt ? (system === "mac" ? "Option" : "Alt") : null,
      key.shift ? "Shift" : null,
      key.meta ? (system === "mac" ? "Cmd" : system === "windows" ? "Win" : "Super") : null,
    ].filter((part) => part !== null);
    return { _tag: "shortcut", keys: [...held, name].join("+") };
  }
  const typing = TYPING.get(key.code);
  if (typing !== undefined)
    return { _tag: "char", char: key.shift ? typing.shifted : typing.plain };
  const named = NAMED.get(key.code);
  if (named === undefined) return { _tag: "none" };
  return { _tag: "named", name: key.shift ? `Shift+${named}` : named };
};
