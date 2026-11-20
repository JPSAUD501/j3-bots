// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Save } from "@j3-bots/client-runtime";
import { Conflict } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { shownSaveProblem } from "./saves";

describe("shownSaveProblem", () => {
  const stale: Save<null> = {
    _tag: "failed",
    changes: null,
    failure: { _tag: "refused", error: new Conflict({ reason: "stale-revision" }) },
  };
  const unexpected: Save<null> = { _tag: "failed", changes: null, failure: { _tag: "unexpected" } };

  it("hides a failure once the operator edits again, but holds a conflict", () => {
    expect(shownSaveProblem(unexpected, false)).toBe("failed");
    expect(shownSaveProblem(unexpected, true)).toBeNull();
    // Saving again would send the same stale revision: only reading the newer version clears it.
    expect(shownSaveProblem(stale, true)).toBe("stale");
  });
});
