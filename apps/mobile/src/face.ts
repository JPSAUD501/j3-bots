// SPDX-License-Identifier: AGPL-3.0-or-later
import type { fontFamilies } from "@j3-bots/design-tokens";

/** One of J3 Bots' three faces. */
export type Face = keyof typeof fontFamilies;

/**
 * The face a `Text` sets. A run nested in another `Text` sets none unless it
 * names one, so it inherits its parent's, as a line of a code block keeps the
 * block's mono; a `Text` on its own is in the text face unless it names one.
 */
export const faceOf = (face: Face | undefined, nested: boolean): Face | undefined =>
  face ?? (nested ? undefined : "text");
