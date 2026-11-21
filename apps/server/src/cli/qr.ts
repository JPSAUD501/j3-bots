// SPDX-License-Identifier: AGPL-3.0-or-later
import { generate } from "lean-qr";

/** Light modules around the code, as the QR standard asks, so a camera finds its edges. */
const QUIET_ZONE = 4;

/** Black on bright white whatever the terminal's own colors, and back to them after. */
const DARK_ON_LIGHT = "\x1b[30;107m";
const RESET = "\x1b[0m";

/**
 * `text` as a QR code a phone's camera reads off the terminal: two rows of
 * modules per line of half blocks, dark on light in every terminal theme, with
 * its quiet zone. A dark module over a light one is `▀`, the reverse `▄`.
 */
export const terminalQr = (text: string): string => {
  const code = generate(text);
  const lines: Array<string> = [];
  for (let y = -QUIET_ZONE; y < code.size + QUIET_ZONE; y += 2) {
    let line = "";
    for (let x = -QUIET_ZONE; x < code.size + QUIET_ZONE; x++) {
      const top = code.get(x, y);
      const bottom = code.get(x, y + 1);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(`${DARK_ON_LIGHT}${line}${RESET}`);
  }
  return lines.join("\n");
};
