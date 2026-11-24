// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BrowserInput, MAX_BROWSER_TEXT_LENGTH } from "@j3-bots/contracts";

// The phone's keyboard types into a hidden field, and the viewer relays each
// change of that field to the page: the characters it erased as Backspace,
// then what it added as text. A keyboard that rewrites a word as it is typed,
// as an IME or autocorrection does, is relayed the same way, so the page
// ends up holding what the field holds.

/** What a change of the hidden field's text did: characters erased from its end, then text added. */
export interface FieldChange {
  readonly erased: number;
  readonly added: string;
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The change from `before` to `after`, counting characters as the page erases them. */
export const fieldChange = (before: string, after: string): FieldChange => {
  let kept = 0;
  const shorter = Math.min(before.length, after.length);
  while (kept < shorter && before[kept] === after[kept]) kept += 1;
  // Never split a character made of two code units.
  if (kept > 0 && isLowSurrogate(before.charCodeAt(kept))) kept -= 1;
  return { erased: Array.from(before.slice(kept)).length, added: after.slice(kept) };
};

/** One key pressed and let go. */
export const keyPress = (key: "Backspace" | "Enter"): ReadonlyArray<BrowserInput> => {
  const keyCode = key === "Backspace" ? 8 : 13;
  const text = key === "Enter" ? { text: "\r" } : {};
  return [
    { type: "key", action: "down", key, code: key, keyCode, modifiers: 0, ...text },
    { type: "key", action: "up", key, code: key, keyCode, modifiers: 0 },
  ];
};

/** `text` in pieces no longer than one `text` frame takes, never splitting a character. */
const pieces = (text: string): ReadonlyArray<string> => {
  const all: Array<string> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_BROWSER_TEXT_LENGTH, text.length);
    if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end -= 1;
    all.push(text.slice(start, end));
    start = end;
  }
  return all;
};

/** What the page receives for a change of the hidden field: a long paste goes in several frames. */
export const relayed = (change: FieldChange): ReadonlyArray<BrowserInput> => [
  ...Array.from({ length: change.erased }, () => keyPress("Backspace")).flat(),
  ...pieces(change.added).map((text) => ({ type: "text", text }) as const),
];
