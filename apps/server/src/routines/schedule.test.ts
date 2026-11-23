// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { MISSED_RUNS_LIMIT, type RoutineTrigger } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { catchUp, localInstant, nextRun, plannedRun } from "./schedule.ts";

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

/** What becomes of runs due from `due` once the server looks at `now`, with instants as ISO text. */
const caughtUp = (trigger: RoutineTrigger, due: string, now: string) => {
  const result = catchUp(trigger, at(due), at(now));
  if (Result.isFailure(result)) throw new Error(`Unexpected ${result.failure.reason}`);
  const plan = result.success;
  return plan._tag === "run"
    ? {
        run: DateTime.formatIso(plan.due),
        next: Option.match(plan.next, { onNone: () => null, onSome: DateTime.formatIso }),
      }
    : {
        skip: plan.missed,
        since: DateTime.formatIso(plan.since),
        until: DateTime.formatIso(plan.until),
        next: DateTime.formatIso(plan.next),
      };
};

describe("catchUp", () => {
  // 08:00 in São Paulo is 11:00 UTC all year.
  const daily = schedule("0 8 * * *", "America/Sao_Paulo");
  const hourly = schedule("0 * * * *", "UTC");

  it("runs a daily run two hours late, nearer to it than to the next one", () => {
    assert.deepStrictEqual(
      caughtUp(daily, "2026-11-20T11:00:00.000Z", "2026-11-20T13:00:00.000Z"),
      {
        run: "2026-11-20T11:00:00.000Z",
        next: "2026-11-21T11:00:00.000Z",
      },
    );
  });

  it("skips a daily run once the next is nearer, counting it as missed", () => {
    // Woken at 07:00 the next day: the 08:00 run is an hour away.
    assert.deepStrictEqual(
      caughtUp(daily, "2026-11-20T11:00:00.000Z", "2026-11-21T10:00:00.000Z"),
      {
        skip: 1,
        since: "2026-11-20T11:00:00.000Z",
        until: "2026-11-20T11:00:00.000Z",
        next: "2026-11-21T11:00:00.000Z",
      },
    );
  });

  it("runs an hourly run up to half an hour late, and skips it after", () => {
    assert.deepStrictEqual(
      caughtUp(hourly, "2026-11-20T09:00:00.000Z", "2026-11-20T09:30:00.000Z"),
      { run: "2026-11-20T09:00:00.000Z", next: "2026-11-20T10:00:00.000Z" },
    );
    assert.deepStrictEqual(
      caughtUp(hourly, "2026-11-20T09:00:00.000Z", "2026-11-20T09:40:00.000Z"),
      {
        skip: 1,
        since: "2026-11-20T09:00:00.000Z",
        until: "2026-11-20T09:00:00.000Z",
        next: "2026-11-20T10:00:00.000Z",
      },
    );
  });

  it("runs a weekly run three days late, for the Monday it was due", () => {
    const weekly = schedule("0 9 * * 1", "UTC");
    assert.deepStrictEqual(
      caughtUp(weekly, "2026-11-16T09:00:00.000Z", "2026-11-19T09:00:00.000Z"),
      { run: "2026-11-16T09:00:00.000Z", next: "2026-11-23T09:00:00.000Z" },
    );
    assert.strictEqual(
      caughtUp(weekly, "2026-11-16T09:00:00.000Z", "2026-11-19T22:00:00.000Z").next,
      "2026-11-23T09:00:00.000Z",
    );
    assert.property(
      caughtUp(weekly, "2026-11-16T09:00:00.000Z", "2026-11-19T22:00:00.000Z"),
      "skip",
    );
  });

  it("runs a one-time trigger however late, with nothing after it", () => {
    const once: RoutineTrigger = { _tag: "once", at: at("2026-11-13T09:00:00.000Z") };
    assert.deepStrictEqual(caughtUp(once, "2026-11-13T09:00:00.000Z", "2026-11-20T10:00:00.000Z"), {
      run: "2026-11-13T09:00:00.000Z",
      next: null,
    });
  });

  it("makes up only the latest of many runs, and counts every one it skips", () => {
    assert.deepStrictEqual(
      caughtUp(hourly, "2026-11-01T00:00:00.000Z", "2026-11-20T12:20:00.000Z"),
      { run: "2026-11-20T12:00:00.000Z", next: "2026-11-20T13:00:00.000Z" },
    );
    // Nineteen days and thirteen hours of hourly runs.
    assert.deepStrictEqual(
      caughtUp(hourly, "2026-11-01T00:00:00.000Z", "2026-11-20T12:40:00.000Z"),
      {
        skip: 19 * 24 + 13,
        since: "2026-11-01T00:00:00.000Z",
        until: "2026-11-20T12:00:00.000Z",
        next: "2026-11-20T13:00:00.000Z",
      },
    );
  });

  it("stops counting a frequent schedule's missed runs at the limit, and still finds the latest", () => {
    // Forty days of runs every five minutes, woken three minutes past one.
    assert.deepStrictEqual(
      caughtUp(
        schedule("*/5 * * * *", "UTC"),
        "2026-10-01T00:00:00.000Z",
        "2026-11-10T00:03:00.000Z",
      ),
      {
        skip: MISSED_RUNS_LIMIT,
        since: "2026-10-01T00:00:00.000Z",
        until: "2026-11-10T00:00:00.000Z",
        next: "2026-11-10T00:05:00.000Z",
      },
    );
  });

  it("measures the half of a night the clocks shorten or lengthen", () => {
    // New York moves to -04:00 on 2026-03-08: the night between 23:00 and
    // 23:00 lasts 23 hours, so 11 h 45 min late is past its half.
    const late = schedule("0 23 * * *", "America/New_York");
    assert.deepStrictEqual(caughtUp(late, "2026-03-08T04:00:00.000Z", "2026-03-08T15:45:00.000Z"), {
      skip: 1,
      since: "2026-03-08T04:00:00.000Z",
      until: "2026-03-08T04:00:00.000Z",
      next: "2026-03-09T03:00:00.000Z",
    });
    // It goes back to -05:00 on 2026-11-01: that night lasts 25 hours, so
    // 12 h 15 min late is still within its half.
    assert.deepStrictEqual(caughtUp(late, "2026-11-01T03:00:00.000Z", "2026-11-01T15:15:00.000Z"), {
      run: "2026-11-01T03:00:00.000Z",
      next: "2026-11-02T04:00:00.000Z",
    });
  });

  it("runs a time the clocks skip, moved later, as the run it stands for", () => {
    // 02:30 does not happen in New York on 2026-03-08; the run comes at 03:30.
    const early = schedule("30 2 * * *", "America/New_York");
    assert.deepStrictEqual(
      caughtUp(early, "2026-03-08T07:30:00.000Z", "2026-03-08T08:00:00.000Z"),
      {
        run: "2026-03-08T07:30:00.000Z",
        next: "2026-03-09T06:30:00.000Z",
      },
    );
  });

  it("tells a run postponed after a defect, and the runs it then missed, by their own times", () => {
    const daily = schedule("0 8 * * *", "UTC");
    // 08:00's run could not be recorded; it was tried again at 08:00:30.
    assert.deepStrictEqual(
      caughtUp(daily, "2026-11-20T08:00:30.000Z", "2026-11-20T08:00:31.000Z"),
      { run: "2026-11-20T08:00:00.000Z", next: "2026-11-21T08:00:00.000Z" },
    );
    // The server stopped before that, and is back at 07:00 the next day.
    assert.deepStrictEqual(
      caughtUp(daily, "2026-11-20T08:00:30.000Z", "2026-11-21T07:00:00.000Z"),
      {
        skip: 1,
        since: "2026-11-20T08:00:00.000Z",
        until: "2026-11-20T08:00:00.000Z",
        next: "2026-11-21T08:00:00.000Z",
      },
    );
    const once: RoutineTrigger = { _tag: "once", at: at("2026-11-20T08:00:00.000Z") };
    assert.deepStrictEqual(caughtUp(once, "2026-11-20T08:00:30.000Z", "2026-11-20T08:00:31.000Z"), {
      run: "2026-11-20T08:00:00.000Z",
      next: null,
    });
  });

  it("finds the runs around a day the clocks skip", () => {
    // Samoa moved from -10:00 to +14:00 at the end of 2011-12-29, local time:
    // 30 December never happened there. Its 09:00 runs on the 29th and the
    // 31st are a day apart, and the 30th's lands on the 31st's.
    const samoa = schedule("0 9 * * *", "Pacific/Apia");
    assert.deepStrictEqual(
      caughtUp(samoa, "2011-12-29T19:00:00.000Z", "2011-12-30T06:00:00.000Z"),
      { run: "2011-12-29T19:00:00.000Z", next: "2011-12-30T19:00:00.000Z" },
    );
    assert.deepStrictEqual(
      caughtUp(samoa, "2011-12-29T19:00:00.000Z", "2011-12-31T08:00:00.000Z"),
      {
        skip: 2,
        since: "2011-12-29T19:00:00.000Z",
        until: "2011-12-30T19:00:00.000Z",
        next: "2011-12-31T19:00:00.000Z",
      },
    );
  });

  it("fails for a schedule it cannot read", () => {
    const result = catchUp(
      schedule("0 9 * * *", "Mars/Olympus"),
      at("2026-11-20T09:00:00.000Z"),
      at("2026-11-20T09:01:00.000Z"),
    );
    assert.isTrue(Result.isFailure(result) && result.failure.reason === "time-zone");
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

describe("localInstant", () => {
  const lisbon = Option.getOrThrow(DateTime.zoneMakeNamed("Europe/Lisbon"));
  const instant = (text: string) =>
    Option.match(localInstant(text, lisbon), { onNone: () => null, onSome: DateTime.formatIso });

  it("reads a time without an offset in the zone, and one with an offset as that instant", () => {
    assert.strictEqual(instant("2026-07-01T09:00"), "2026-07-01T08:00:00.000Z");
    assert.strictEqual(instant("2026-07-01T09:00:30+02:00"), "2026-07-01T07:00:30.000Z");
    assert.strictEqual(instant("2026-07-01T09:00Z"), "2026-07-01T09:00:00.000Z");
  });

  it("moves a time the clocks skip later, as a schedule does", () => {
    // Lisbon skips 01:00 to 02:00 on 2026-03-29.
    assert.strictEqual(instant("2026-03-29T01:30"), "2026-03-29T01:30:00.000Z");
  });

  it("reads a time the clocks repeat as its first occurrence, unless an offset names the second", () => {
    // Lisbon goes back from 02:00 to 01:00 on 2026-10-25: 01:30 comes at +01:00, then at +00:00.
    assert.strictEqual(instant("2026-10-25T01:30"), "2026-10-25T00:30:00.000Z");
    assert.strictEqual(instant("2026-10-25T01:30+00:00"), "2026-10-25T01:30:00.000Z");
  });

  it("refuses a date or a time that does not exist", () => {
    assert.isNull(instant("2026-02-31T09:00"));
    assert.isNull(instant("2026-07-01T24:00"));
    assert.isNull(instant("2026-07-01T09:00+24:00"));
  });
});
