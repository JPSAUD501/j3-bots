// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import type { RoutineTrigger } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { nextRun, plannedRun } from "./schedule.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const schedule = (cron: string, timeZone: string): RoutineTrigger => ({
  _tag: "schedule",
  cron,
  timeZone,
});

/** The next run after `after`, as an ISO instant, or null when there is none. */
const next = (trigger: RoutineTrigger, after: string) => {
  const result = nextRun(trigger, at(after));
  if (Result.isFailure(result)) throw new Error(`Unexpected ${result.failure.reason}`);
  return Option.match(result.success, { onNone: () => null, onSome: DateTime.formatIso });
};

describe("nextRun", () => {
  it("reads a schedule as wall-clock time in its own zone", () => {
    assert.strictEqual(
      next(schedule("0 9 * * *", "America/Sao_Paulo"), "2026-11-20T10:00:00.000Z"),
      "2026-11-20T12:00:00.000Z",
    );
  });

  it("keeps a schedule's wall-clock time across a change of the clocks", () => {
    // Lisbon moves from +00:00 to +01:00 on Sunday 2026-03-29.
    const weekdays = schedule("47 8 * * 1-5", "Europe/Lisbon");
    assert.strictEqual(next(weekdays, "2026-03-27T09:00:00.000Z"), "2026-03-30T07:47:00.000Z");
    assert.strictEqual(next(weekdays, "2026-03-26T09:00:00.000Z"), "2026-03-27T08:47:00.000Z");
  });

  it("runs a time the clocks skip once, as late as the gap is long", () => {
    // New York skips 02:00-02:59 on 2026-03-08: 02:30 does not happen that day,
    // and the run comes at 03:30.
    const daily = schedule("30 2 * * *", "America/New_York");
    assert.strictEqual(next(daily, "2026-03-08T05:00:00.000Z"), "2026-03-08T07:30:00.000Z");
    assert.strictEqual(next(daily, "2026-03-08T07:30:00.000Z"), "2026-03-09T06:30:00.000Z");
  });

  it("runs every skipped time of a schedule, each moved as late as the gap is long", () => {
    const twice = schedule("0,30 2 * * *", "America/New_York");
    assert.strictEqual(next(twice, "2026-03-08T05:00:00.000Z"), "2026-03-08T07:00:00.000Z");
    assert.strictEqual(next(twice, "2026-03-08T07:00:00.000Z"), "2026-03-08T07:30:00.000Z");
    assert.strictEqual(next(twice, "2026-03-08T07:30:00.000Z"), "2026-03-09T06:00:00.000Z");
  });

  it("runs a time the clocks repeat once, at its first occurrence", () => {
    // New York repeats 01:00-01:59 on 2026-11-01, first at -04:00, then at -05:00.
    const daily = schedule("30 1 * * *", "America/New_York");
    assert.strictEqual(next(daily, "2026-11-01T04:00:00.000Z"), "2026-11-01T05:30:00.000Z");
    assert.strictEqual(next(daily, "2026-11-01T05:30:00.000Z"), "2026-11-02T06:30:00.000Z");
  });

  it("fires a one-time trigger only while its time lies ahead", () => {
    const once: RoutineTrigger = { _tag: "once", at: at("2026-11-21T09:00:00.000Z") };
    assert.strictEqual(next(once, "2026-11-20T09:00:00.000Z"), "2026-11-21T09:00:00.000Z");
    assert.strictEqual(next(once, "2026-11-21T09:00:00.000Z"), null);
    assert.strictEqual(next({ _tag: "webhook" }, "2026-11-21T09:00:00.000Z"), null);
  });
});

describe("plannedRun", () => {
  const now = at("2026-11-20T10:00:00.000Z");
  const reason = (trigger: RoutineTrigger) =>
    plannedRun(trigger, now).pipe(
      Effect.flip,
      Effect.map((invalid) => invalid.reason),
    );

  it.effect("refuses a schedule that runs within five minutes of its previous run", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reason(schedule("*/2 * * * *", "UTC")), "schedule");
      // Every five minutes is the closest allowed.
      const run = yield* plannedRun(schedule("*/5 * * * *", "UTC"), now);
      assert.deepStrictEqual(run, Option.some(at("2026-11-20T10:05:00.000Z")));
      // On 2026-03-08 New York skips 02:00-02:59: 02:00 and 02:30 land on
      // 03:00 and 03:30, which run anyway. One run each, not two too close.
      const skipped = yield* plannedRun(
        schedule("0,30 2,3 * * *", "America/New_York"),
        at("2026-03-05T12:00:00.000Z"),
      );
      assert.deepStrictEqual(skipped, Option.some(at("2026-03-06T07:00:00.000Z")));
    }),
  );

  it.effect("refuses an expression it cannot read, and a zone it does not know", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reason(schedule("0 9 * *", "UTC")), "schedule");
      assert.strictEqual(yield* reason(schedule("0 0 9 * * *", "UTC")), "schedule");
      assert.strictEqual(yield* reason(schedule("0 9 * * *", "Mars/Olympus")), "time-zone");
    }),
  );

  it.effect("refuses a schedule that names no date that exists", () =>
    Effect.gen(function* () {
      const never = schedule("0 0 31 2 *", "UTC");
      assert.strictEqual(yield* reason(never), "schedule");
      const result = nextRun(never, now);
      assert.isTrue(Result.isFailure(result) && result.failure.reason === "schedule");
      // A date that exists only in leap years is a date.
      const leap = yield* plannedRun(schedule("0 0 29 2 *", "UTC"), now);
      assert.deepStrictEqual(leap, Option.some(at("2028-02-29T00:00:00.000Z")));
    }),
  );

  it.effect("refuses a one-time trigger whose time has passed", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* reason({ _tag: "once", at: at("2026-11-20T09:59:00.000Z") }),
        "schedule",
      );
    }),
  );
});
