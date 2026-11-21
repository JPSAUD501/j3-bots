// SPDX-License-Identifier: AGPL-3.0-or-later

/** How a line of code is set apart: an added or removed line of a diff, or one that only places the rest. */
export type CodeLineTone = "added" | "removed" | "quiet";

/** A hunk header, with the lengths of its old and new ranges; a missing length is one line. */
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * A unified diff's tones, line by line, by where each line stands. Inside a
 * hunk, `+` lines are added and `-` lines removed, whatever follows: `----`
 * removes a Markdown rule. Hunk headers (`@@`) are quiet, and so are file
 * headers (`---`, `+++`), which stand only outside a hunk. A hunk ends when it
 * has given the lines its header counts; one whose header gives no counts runs
 * to the next header.
 */
export function diffTones(lines: ReadonlyArray<string>): ReadonlyArray<CodeLineTone | undefined> {
  let oldLeft = 0;
  let newLeft = 0;
  let uncounted = false;
  return lines.map((line) => {
    if (line.startsWith("@@")) {
      const counts = HUNK.exec(line);
      uncounted = counts === null;
      oldLeft = Number(counts?.[1] ?? 1);
      newLeft = Number(counts?.[2] ?? 1);
      return "quiet";
    }
    if (!uncounted && oldLeft <= 0 && newLeft <= 0) {
      if (line.startsWith("---") || line.startsWith("+++")) return "quiet";
      if (line.startsWith("+")) return "added";
      if (line.startsWith("-")) return "removed";
      return undefined;
    }
    if (line.startsWith("+")) {
      newLeft -= 1;
      return "added";
    }
    if (line.startsWith("-")) {
      oldLeft -= 1;
      return "removed";
    }
    // "\ No newline at end of file" stands for no line of either side.
    if (!line.startsWith("\\")) {
      oldLeft -= 1;
      newLeft -= 1;
    }
    return undefined;
  });
}
