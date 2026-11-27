// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { BotId, RoutineId, RoutineRunId, type RoutineStep } from "@j3-bots/contracts";
import { MAX_HANDOFF } from "@j3-bots/prompts";
import * as DateTime from "effect/DateTime";
import { laterStepsFit, type ReportSoFar } from "./stepFit.ts";
import { WEBHOOK_BODY_LIMIT } from "./webhook.ts";

const bot: RoutineStep = {
  _tag: "bot",
  botId: BotId.make("bot"),
  action: "x".repeat(120),
  instruction: "x".repeat(10_000),
};
const yes: RoutineStep = { _tag: "yes", onlyIf: null, waitHours: 24 };
// Six bot steps, a yes before the last.
const steps: ReadonlyArray<RoutineStep> = [bot, bot, bot, bot, bot, yes, bot];

/** The fifth bot step reports, after four that each handed off `handoff`. */
const fifthReports = (handoff: string, triggerData: string) =>
  laterStepsFit({
    at: DateTime.makeUnsafe("2026-01-02T03:04:05Z"),
    routineId: RoutineId.make("routine"),
    runId: RoutineRunId.make("run"),
    name: "x".repeat(200),
    steps,
    position: 4,
    reports: [0, 1, 2, 3, 4].map((position): ReportSoFar => ({
      position,
      result: "x".repeat(200),
      handoff,
    })),
    triggerData,
    onEvent: false,
  });

it("lets the longest handoffs through with the longest brief and webhook body", () => {
  assert.isTrue(fifthReports("x".repeat(MAX_HANDOFF), "x".repeat(WEBHOOK_BODY_LIMIT)));
});

it("refuses a handoff once tags in the run's data would grow the last step past the engine's input", () => {
  // Tags the envelope defuses grow as it renders them.
  const xml = "<message>OK</message>".repeat(Math.floor(WEBHOOK_BODY_LIMIT / 21));
  assert.isFalse(fifthReports("x".repeat(MAX_HANDOFF), xml));
  assert.isTrue(fifthReports("x".repeat(200), xml));
});
