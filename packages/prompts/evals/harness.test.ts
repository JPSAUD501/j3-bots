// SPDX-License-Identifier: AGPL-3.0-or-later
import { RoutineId, RoutineRunId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DECODE_OPTIONS, type RoutineWake, tools, type Wake } from "../src/index.ts";
import { HeldRoutines } from "./harness.ts";

// What `set_routine` and `list_routines` answer within one turn, as the
// server would, after earlier calls changed what it holds.

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
  runId: Schema.decodeSync(RoutineRunId)("run-1"),
  recentRunsLeftOut: false,
  recentRuns: [],
  triggerData: null,
  dueAt: null,
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

const create = decodeInput({
  action: "create",
  name: "Docs build",
  instruction: "Check the docs build.",
  schedule: "47 7 * * 1-5",
});

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
    routines.set(create);
    expect(listed(routines)).toEqual([
      { id: "routine-1", enabled: true, nextRunAt: "2026-11-23T07:47:00.000Z" },
    ]);
  });

  it("gives each routine it creates an id of its own", () => {
    const routines = new HeldRoutines(conversation);
    routines.set(create);
    routines.set(create);
    expect(listed(routines).map((routine) => routine.id)).toEqual(["routine-1", "routine-2"]);
  });

  it.each([
    { action: "update", id: "routine-1", name: "Docs" },
    { action: "pause", id: "routine-1" },
    { action: "resume", id: "routine-1" },
    { action: "delete", id: "routine-1" },
  ])("refuses $action of a routine it does not hold", (input) => {
    const routines = new HeldRoutines(conversation);
    expect(routines.set(decodeInput(input)).refused).toBe(true);
    expect(listed(routines)).toEqual([]);
  });

  it("pauses, resumes and deletes a routine created earlier in the turn", () => {
    const routines = new HeldRoutines(conversation);
    routines.set(create);
    expect(routines.set(decodeInput({ action: "pause", id: "routine-1" })).refused).toBe(false);
    expect(listed(routines)).toEqual([{ id: "routine-1", enabled: false, nextRunAt: null }]);
    expect(routines.set(decodeInput({ action: "resume", id: "routine-1" })).refused).toBe(false);
    expect(listed(routines)).toEqual([
      { id: "routine-1", enabled: true, nextRunAt: "2026-11-23T07:47:00.000Z" },
    ]);
    expect(routines.set(decodeInput({ action: "delete", id: "routine-1" })).refused).toBe(false);
    expect(listed(routines)).toEqual([]);
  });

  it("moves the next run with a new schedule, and refuses one the server would", () => {
    const routines = new HeldRoutines(conversation);
    routines.set(create);
    const update = (schedule: string) =>
      routines.set(decodeInput({ action: "update", id: "routine-1", schedule }));
    expect(update("15 12 * * *").refused).toBe(false);
    expect(listed(routines)).toEqual([
      { id: "routine-1", enabled: true, nextRunAt: "2026-11-20T12:15:00.000Z" },
    ]);
    expect(update("*/2 * * * *").refused).toBe(true);
    expect(listed(routines)).toEqual([
      { id: "routine-1", enabled: true, nextRunAt: "2026-11-20T12:15:00.000Z" },
    ]);
  });

  it("keeps a paused routine paused through an update of its instruction", () => {
    const routines = new HeldRoutines(conversation);
    routines.set(create);
    routines.set(decodeInput({ action: "pause", id: "routine-1" }));
    routines.set(
      decodeInput({ action: "update", id: "routine-1", instruction: "Check it twice." }),
    );
    expect(listed(routines)).toEqual([{ id: "routine-1", enabled: false, nextRunAt: null }]);
    expect(routines.current[0]?.instruction).toBe("Check it twice.");
  });

  it("takes only a pause of its own routine during a run", () => {
    const routines = new HeldRoutines(run);
    expect(routines.set(create).refused).toBe(true);
    expect(routines.set(decodeInput({ action: "pause", id: "routine-9" })).refused).toBe(true);
    expect(listed(routines)).toEqual([
      { id, enabled: true, nextRunAt: "2026-11-20T11:17:00.000Z" },
    ]);
  });
});
