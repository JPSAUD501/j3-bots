// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { MISSED_RUNS_LIMIT, Routine } from "./routine.ts";

describe("a routine's missed runs across server versions", () => {
  it("reads a count past this release's limit, which a later server may send", () => {
    const routine = Schema.decodeSync(Schema.toCodecJson(Routine))({
      id: "rtn_1",
      botId: "bot_1",
      name: "Backup check",
      instruction: "Check last night's backup.",
      trigger: { _tag: "schedule", cron: "*/5 * * * *", timeZone: "UTC" },
      enabled: true,
      webhookUrl: null,
      nextRunAt: "2026-11-20T10:05:00.000Z",
      lastRun: null,
      runCount: 3,
      missed: {
        count: MISSED_RUNS_LIMIT * 4,
        since: "2026-10-01T00:00:00.000Z",
        until: "2026-11-20T10:00:00.000Z",
      },
    });
    assert.strictEqual(routine.missed?.count, MISSED_RUNS_LIMIT * 4);
  });
});
