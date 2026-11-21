// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CodeLineTone } from "@j3-bots/client-runtime/presentation";
import { cn } from "../lib/cn";

const toneClass: Record<CodeLineTone, string> = {
  added: "bg-success/12",
  removed: "bg-blocked/12",
  quiet: "text-muted-foreground",
};

/**
 * Code set one block per line, each with a hanging indent: a long line wraps
 * under itself, indented, so its continuation never reads as the next line.
 * Leading spaces stay. An empty line is a line break, so selecting the block
 * copies the text exactly as given. `tones` tints each line by what it says
 * and where it stands; the text stays as given, so copying is unchanged. The caller sets the font and
 * `whitespace-pre-wrap`.
 */
export function CodeLines({
  text,
  tones,
  inset = false,
}: {
  text: string;
  tones?: (lines: ReadonlyArray<string>) => ReadonlyArray<CodeLineTone | undefined>;
  /**
   * The lines carry the block's side padding, so a tint spans its whole width.
   * The block then sets only its padding above and below.
   */
  inset?: boolean;
}) {
  const lines = text.split("\n");
  const lineTones = tones?.(lines);
  return lines.map((line, index) => {
    const lineTone = lineTones?.[index];
    return (
      <span
        // oxlint-disable-next-line react/no-array-index-key -- lines are positional: a line is its place in the text
        key={index}
        className={cn(
          "block -indent-[4ch]",
          inset ? "ps-[calc(4ch+--spacing(2.5))] pe-2.5" : "ps-[4ch]",
          lineTone !== undefined && toneClass[lineTone],
        )}
      >
        {line === "" ? <br /> : line}
      </span>
    );
  });
}
