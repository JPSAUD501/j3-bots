// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DECODE_OPTIONS, type RoutineWake, tools, type Wake } from "../src/index.ts";
import { HeldRoutines } from "./harness.ts";

// What `list_routines` answers within one turn, after `set_routine` changed
// what the server holds.

const at = DateTime.makeUnsafe("2026-11-20T10:17:00.000Z");
const timeZone = DateTime.zoneMakeNamedUnsafe("Europe/Lisbon");
const id = Schema.decodeSync(RoutineId)("routine-7");

const run: RoutineWake = {
  at,
  timeZone,
  sinceLastTurn: [],
  kind: "routine",
  routine: {
    id,
    name: "Release watch",
    trigger: { type: "schedule", cron: "17 8-18 * * *" },
    instruction: "Once release 2.0 of acme/docs is out, tell your user, then pause this routine.",
  },
  recentRuns: [],
  triggerData: null,
};

const conversation: Wake = {
  at,
  timeZone,
  sinceLastTurn: [],
  kind: "user",
  answer: null,
  messages: [{ at, text: "Check the docs build every weekday at 8.", attachments: [] }],
};

const decodeInput = Schema.decodeUnknownSync(tools.set_routine.input, DECODE_OPTIONS);
const decodeListed = Schema.decodeUnknownSync(
  Schema.Struct({
    routines: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        enabled: Schema.Boolean,
        nextRunAt: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
const listed = (routines: HeldRoutines) => decodeListed(routines.list()).routines;

describe("the routines a turn's stubs hold", () => {
  it("lists a run's routine paused once the run paused it", () => {
    const routines = new HeldRoutines(run);
    expect(listed(routines)).toEqual([
      { id, enabled: true, nextRunAt: "2026-11-20T11:17:00.000Z" },
    ]);
    expect(routines.set(decodeInput({ action: "pause", id })).refused).toBe(false);
    expect(listed(routines)).toEqual([{ id, enabled: false, nextRunAt: null }]);
  });

  it("lists a routine a conversation created", () => {
    const routines = new HeldRoutines(conversation);
    expect(listed(routines)).toEqual([]);
    routines.set(
      decodeInput({
        action: "create",
        name: "Docs build",
        instruction: "Check the docs build.",
        schedule: "47 7 * * 1-5",
      }),
    );
    expect(listed(routines)).toEqual([
      { id: "routine-1", enabled: true, nextRunAt: "2026-11-23T07:47:00.000Z" },
    ]);
  });
});
