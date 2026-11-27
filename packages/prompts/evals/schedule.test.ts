// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DECODE_OPTIONS, tools, type Wake } from "../src/index.ts";
import { HeldRoutines } from "./harness.ts";

// The `set_routine` stub against the server's own boundary examples
// (`apps/server/src/routines/schedule.test.ts`): what the server refuses, the
// stub refuses, and what it accepts gets the first run the server plans. The
// one-time examples are moved a year on, to lie ahead of the time they are
// saved at, so the impossible ones are refused only for being impossible. An
// expression without five fields never reaches the stub: the tool's own
// schema refuses it.

const wake = (now: string, zone: string): Wake => ({
  at: DateTime.makeUnsafe(now),
  timeZone: DateTime.zoneMakeNamedUnsafe(zone),
  sinceLastTurn: [],
  kind: "user",
  answer: null,
  messages: [
    { at: DateTime.makeUnsafe(now), text: "Set it up.", attachments: [], lookingAt: null },
  ],
});

const decodeInput = Schema.decodeUnknownSync(tools.set_routine.input, DECODE_OPTIONS);
const decodeSaved = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ nextRunAt: Schema.String })),
);

/** The first run the stub plans for a routine created at `now`, or `refused`. */
const planned = (trigger: { schedule: string } | { at: string }, now: string, zone: string) => {
  const saved = new HeldRoutines(wake(now, zone)).set(
    decodeInput({ action: "create", name: "Check", instruction: "Check.", ...trigger }),
  );
  return saved.refused ? "refused" : decodeSaved(saved.output).nextRunAt;
};

const NOW = "2026-11-20T10:00:00.000Z";

describe("the set_routine stub, on the server's examples", () => {
  it.each([
    ["*/2 * * * *", "UTC", NOW, "refused"],
    ["*/5 * * * *", "UTC", NOW, "2026-11-20T10:05:00.000Z"],
    ["0,30 2,3 * * *", "America/New_York", "2026-03-05T12:00:00.000Z", "2026-03-06T07:00:00.000Z"],
    ["61 9 * * *", "UTC", NOW, "refused"],
    ["0 0 31 2 *", "UTC", NOW, "refused"],
    ["0 0 29 2 *", "UTC", NOW, "2028-02-29T00:00:00.000Z"],
    ["0 9 * * *", "America/Sao_Paulo", NOW, "2026-11-20T12:00:00.000Z"],
    ["47 8 * * 1-5", "Europe/Lisbon", "2026-03-27T09:00:00.000Z", "2026-03-30T07:47:00.000Z"],
    ["30 2 * * *", "America/New_York", "2026-03-08T05:00:00.000Z", "2026-03-08T07:30:00.000Z"],
    ["30 1 * * *", "America/New_York", "2026-11-01T04:00:00.000Z", "2026-11-01T05:30:00.000Z"],
  ])("plans %j in %s, saved at %s, as %s", (schedule, zone, now, expected) => {
    expect(planned({ schedule }, now, zone)).toBe(expected);
  });

  it.each([
    ["2026-11-20T09:59Z", "refused"],
    ["2027-02-31T09:00", "refused"],
    ["2027-07-01T24:00", "refused"],
    ["2027-07-01T09:00+24:00", "refused"],
    ["2027-07-01T09:00", "2027-07-01T08:00:00.000Z"],
    ["2027-07-01T09:00:30+02:00", "2027-07-01T07:00:30.000Z"],
    ["2027-03-28T01:30", "2027-03-28T01:30:00.000Z"],
    ["2027-10-31T01:30", "2027-10-31T00:30:00.000Z"],
    ["2027-10-31T01:30+00:00", "2027-10-31T01:30:00.000Z"],
  ])("plans a one-time run at %j in Lisbon as %s", (at, expected) => {
    expect(planned({ at }, NOW, "Europe/Lisbon")).toBe(expected);
  });
});
