// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Code set one block per line, each with a hanging indent: a long line wraps
 * under itself, indented, so its continuation never reads as the next line.
 * Leading spaces stay. An empty line is a line break, so selecting the block
 * copies the text exactly as given. The caller sets the font and
 * `whitespace-pre-wrap`.
 */
export function CodeLines({ text }: { text: string }) {
  return text.split("\n").map((line, index) => (
    // oxlint-disable-next-line react/no-array-index-key -- lines are positional: a line is its place in the text
    <span key={index} className="block ps-[4ch] -indent-[4ch]">
      {line === "" ? <br /> : line}
    </span>
  ));
}
