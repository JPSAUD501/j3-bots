// SPDX-License-Identifier: AGPL-3.0-or-later
import { generate } from "lean-qr";

/** Light modules around the code, as the QR standard asks, so a camera finds its edges. */
const QUIET_ZONE = 4;

/** Black on bright white whatever the terminal's own colors, and back to them after. */
const DARK_ON_LIGHT = "\x1b[30;107m";
const RESET = "\x1b[0m";

/** The row the shell's prompt takes once the command ends. */
const PROMPT_ROWS = 1;

/** The terminal a QR code is printed to: whether it is one, and its size in cells. */
export interface TerminalSize {
  readonly isTerminal: boolean;
  readonly columns: number;
  readonly rows: number;
}

/** The rows `line` takes on a terminal `columns` wide, which wraps it. */
const wrappedRows = (line: string, columns: number) =>
  Math.max(1, Math.ceil([...line].length / columns));

/**
 * `caption`, then `text` as a QR code a phone's camera reads off the terminal:
 * two rows of modules per line of half blocks, dark on light in every terminal
 * theme, with its quiet zone. A dark module over a light one is `▀`, the
 * reverse `▄`. The code is printed last, so the shell's prompt after it scrolls
 * the caption, never the code, off the top. Nothing is drawn when standard
 * output is not a terminal, which would keep the escape sequences as text, or
 * is one too small to show the caption, the code with its quiet zone and the
 * prompt's row whole (`too-small`, with a size that does), which wraps or
 * cuts the code's lines so no camera reads them.
 */
export const terminalQr = (
  text: string,
  caption: ReadonlyArray<string>,
  terminal: TerminalSize,
):
  | { readonly _tag: "shown"; readonly lines: string }
  | { readonly _tag: "not-a-terminal" }
  | { readonly _tag: "too-small"; readonly columns: number; readonly rows: number } => {
  if (!terminal.isTerminal) return { _tag: "not-a-terminal" };
  const code = generate(text);
  const side = code.size + 2 * QUIET_ZONE;
  const rowsAt = (columns: number) =>
    caption.reduce((rows, line) => rows + wrappedRows(line, columns), 0) +
    Math.ceil(side / 2) +
    PROMPT_ROWS;
  if (terminal.columns < side || terminal.rows < rowsAt(terminal.columns)) {
    return { _tag: "too-small", columns: side, rows: rowsAt(side) };
  }
  const lines: Array<string> = [...caption];
  for (let y = -QUIET_ZONE; y < code.size + QUIET_ZONE; y += 2) {
    let line = "";
    for (let x = -QUIET_ZONE; x < code.size + QUIET_ZONE; x++) {
      const top = code.get(x, y);
      const bottom = code.get(x, y + 1);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(`${DARK_ON_LIGHT}${line}${RESET}`);
  }
  return { _tag: "shown", lines: lines.join("\n") };
};
