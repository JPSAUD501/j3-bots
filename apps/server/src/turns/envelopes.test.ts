// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineId, RoutineRunId } from "@j3-bots/contracts";
import { MAX_HANDOFF, type Wake } from "@j3-bots/prompts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { WEBHOOK_BODY_LIMIT } from "../routines/webhook.ts";
import { fitsEngine } from "./envelopes.ts";

const at = DateTime.makeUnsafe("2026-01-02T03:04:05Z");
const full = (length: number) => "x".repeat(length);

it("fits the last step of the longest routine in steps in the engine's input", () => {
  // Six bot steps: the five before the last each handed off all they may.
  const earlier = Array.from({ length: 5 }, () => ({
    bot: full(40),
    action: full(120),
    result: full(200),
    handoff: full(MAX_HANDOFF),
  }));
  const wake: Wake = {
    at,
    timeZone: DateTime.zoneMakeNamedUnsafe("America/Sao_Paulo"),
    sinceLastTurn: [],
    kind: "routine",
    routine: {
      id: RoutineId.make("routine"),
      name: full(200),
      trigger: { type: "webhook" },
      instruction: full(10_000),
    },
    step: {
      number: 6,
      of: 6,
      action: full(120),
      earlier,
      approved: { question: full(2_000), note: full(2_000) },
      next: null,
    },
    runId: RoutineRunId.make("run"),
    recentRuns: [],
    recentRunsLeftOut: false,
    triggerData: full(WEBHOOK_BODY_LIMIT),
    dueAt: null,
  };
  assert.isTrue(fitsEngine(wake));
});
