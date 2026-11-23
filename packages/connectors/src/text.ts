// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the first `max` characters (code points) of `text` end, or null when
 * it has no more than `max`. It reads no further than that, so a remote
 * answer of several megabytes costs no copy of itself.
 */
export const codePointsEnd = (text: string, max: number): number | null => {
  let index = 0;
  for (let count = 0; count < max; count++) {
    if (index >= text.length) return null;
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return index >= text.length ? null : index;
};
