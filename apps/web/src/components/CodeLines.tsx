// SPDX-License-Identifier: AGPL-3.0-or-later
import { cn } from "../lib/cn";

/** How a line of code is set apart: an added or removed line of a diff, or one that only places the rest. */
export type CodeLineTone = "added" | "removed" | "quiet";

const toneClass: Record<CodeLineTone, string> = {
  added: "bg-success/12",
  removed: "bg-blocked/12",
  quiet: "text-muted-foreground",
};

/** A unified diff's tones: `+` lines added, `-` lines removed, `@@` hunk headers quiet. */
export function diffTone(line: string): CodeLineTone | undefined {
  if (line.startsWith("@@")) return "quiet";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return undefined;
}

/**
 * Code set one block per line, each with a hanging indent: a long line wraps
 * under itself, indented, so its continuation never reads as the next line.
 * Leading spaces stay. An empty line is a line break, so selecting the block
 * copies the text exactly as given. `tone` tints a line by what it says; the
 * text stays as given, so copying is unchanged. The caller sets the font and
 * `whitespace-pre-wrap`.
 */
export function CodeLines({
  text,
  tone,
}: {
  text: string;
  tone?: (line: string) => CodeLineTone | undefined;
}) {
  return text.split("\n").map((line, index) => {
    const lineTone = tone?.(line);
    return (
      <span
        // oxlint-disable-next-line react/no-array-index-key -- lines are positional: a line is its place in the text
        key={index}
        className={cn(
          "block ps-[4ch] -indent-[4ch]",
          lineTone !== undefined && toneClass[lineTone],
        )}
      >
        {line === "" ? <br /> : line}
      </span>
    );
  });
}
