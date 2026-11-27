// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type LookingAt,
  MAX_LOOKING_AT_APP_LENGTH,
  MAX_LOOKING_AT_TITLE_LENGTH,
} from "@j3-bots/contracts";

/**
 * Line breaks, tabs and the other control characters, which a title shown
 * on one line cannot hold, and the marks that turn text's direction around
 * (U+202A to U+202E, U+2066 to U+2069), with which a title could show other
 * words than it holds.
 */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩\s]+/gu;

/**
 * `text` on one line, its runs of space and control characters one space,
 * trimmed, and cut to `max` UTF-16 code units with an ellipsis, never
 * between the halves of a character; `null` when nothing is left.
 */
export const oneLine = (text: string, max: number): string | null => {
  const line = text.replace(BREAKS, " ").trim();
  if (line === "") return null;
  if (line.length <= max) return line;
  let cut = "";
  for (const character of line) {
    if (cut.length + character.length > max - 1) break;
    cut += character;
  }
  return `${cut.trimEnd()}…`;
};

/**
 * What a chip shows and the bot reads of a window, from what the system
 * said of it: the app's name, and its title when `withTitle`. `null` when
 * the app has no name to show, as nothing is shown then.
 */
export const lookingAtOf = (
  app: string | null,
  title: string | null,
  withTitle: boolean,
): LookingAt | null => {
  const named = app === null ? null : oneLine(app, MAX_LOOKING_AT_APP_LENGTH);
  if (named === null) return null;
  const titled = withTitle && title !== null ? oneLine(title, MAX_LOOKING_AT_TITLE_LENGTH) : null;
  // A title that only repeats the app's name says nothing more.
  return titled === null || titled === named ? { app: named } : { app: named, title: titled };
};
