// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { diffTones } from "./diff.ts";

describe("diffTones", () => {
  it("quiets file headers before a hunk, but tints a removed `---` line inside one", () => {
    const diff = [
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,3 +1,3 @@",
      " # Title",
      "----",
      "+++ added text",
      " end",
    ];
    expect(diffTones(diff)).toEqual([
      "quiet",
      "quiet",
      "quiet",
      undefined,
      "removed",
      "added",
      undefined,
    ]);
  });

  it("quiets the headers of a file that follows a finished hunk", () => {
    const diff = [
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/next.txt",
      "+++ b/next.txt",
      "@@ -0,0 +1 @@",
      "+c",
    ];
    expect(diffTones(diff)).toEqual([
      "quiet",
      "removed",
      "added",
      "quiet",
      "quiet",
      "quiet",
      "added",
    ]);
  });
});
