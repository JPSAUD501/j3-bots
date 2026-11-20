// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { approvalDetail } from "./approvalDetail.ts";

describe("approvalDetail", () => {
  it("never repeats the action, keeping only what the prompt adds", () => {
    const action = "pnpm db:migrate --env staging";
    assert.strictEqual(
      approvalDetail(action, ["  pnpm db:migrate --env staging \n", undefined]),
      null,
    );
    assert.strictEqual(
      approvalDetail(action, ["pnpm db:migrate --env staging\n  --to 0042\n", "Needs network"]),
      "--to 0042\n\nNeeds network",
    );
  });

  it("keeps a prompt whole when the action came from elsewhere or was cut short", () => {
    assert.strictEqual(
      approvalDetail("Write notes.txt", ["@@ -1 +1 @@\n-a\n+b\n"]),
      "@@ -1 +1 @@\n-a\n+b",
    );
    const long = "x".repeat(250);
    assert.strictEqual(approvalDetail(`${"x".repeat(199)}…`, [long]), long);
  });

  it("is null rather than empty or blank, and says a repeated text once", () => {
    assert.strictEqual(approvalDetail("Run it", ["", " \n\t "]), null);
    assert.strictEqual(approvalDetail("Run it", ["Because", "Because"]), "Because");
  });
});
