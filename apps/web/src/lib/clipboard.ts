// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Writes `text` to the clipboard, where the page has one (not over plain HTTP
 * on the local network) and the browser lets it: whether it got there.
 */
export const writeClipboard = (text: string): Promise<boolean> =>
  "clipboard" in navigator
    ? navigator.clipboard.writeText(text).then(
        () => true,
        () => false,
      )
    : Promise.resolve(false);
