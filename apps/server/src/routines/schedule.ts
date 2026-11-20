// SPDX-License-Identifier: AGPL-3.0-or-later
import { Invalid, type RoutineTrigger } from "@j3-bots/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

// When a routine's trigger fires (`docs/architecture/server.md`, Routines). A
// schedule is a five-field cron expression read as wall-clock time in its own
// zone: a time that occurs twice when the clocks go back runs once, at its
// first occurrence, and a time the clocks skip runs once that day, as much
// later as the clocks moved (02:30 becomes 03:30). A one-time trigger fires at
// its instant. A webhook has no time.

/** The least time between two runs of a schedule. */
const MIN_SPACING = Duration.minutes(5);

/**
 * How far ahead of now a schedule's runs are checked against `MIN_SPACING`:
 * over a week, so every weekday and both of a week's clock changes are seen.
 */
const SPACING_WINDOW = Duration.days(8);

/**
 * How far a run's wall-clock time, read as UTC, can lie from its instant: a
 * zone's offset (at most 14 hours either way) and a skipped stretch of the
 * clock (at most a day) together stay within it.
 */
const WALL_MARGIN_MILLIS = Duration.toMillis(Duration.days(2));

type Schedule = Extract<RoutineTrigger, { readonly _tag: "schedule" }>;

/**
 * A schedule as it is searched: the expression's wall-clock times, which
 * `Cron` finds as if the zone were UTC, and the zone they are resolved in.
 */
interface Compiled {
  readonly wall: Cron.Cron;
  readonly zone: DateTime.TimeZone.Named;
}

const unreadable = () => new Invalid({ reason: "schedule" });

/**
 * Runs a search of `Cron`'s, which throws when an expression names no date
 * that exists (`0 0 31 2 *`): such a schedule never runs, and cannot be saved.
 */
const search = <A>(run: () => A): Result.Result<A, Invalid> =>
  Result.try({ try: run, catch: unreadable });

/** A schedule as it is searched, or why it cannot be. */
const compile = (trigger: Schedule): Result.Result<Compiled, Invalid> => {
  const zone = DateTime.zoneMakeNamed(trigger.timeZone);
  if (Option.isNone(zone)) return Result.fail(new Invalid({ reason: "time-zone" }));
  // Five fields only: `Cron` also reads a leading seconds field.
  if (trigger.cron.trim().split(/\s+/).length !== 5) return Result.fail(unreadable());
  return Result.flatMap(Result.mapError(Cron.parse(trigger.cron, "UTC"), unreadable), (wall) =>
    // One search, from any point, tells an expression that names a date from one that never does.
    Result.map(
      search(() => Cron.next(wall, 0)),
      () => ({ wall, zone: zone.value }),
    ),
  );
};

/**
 * The schedule's runs, as epoch milliseconds, in the order of their wall-clock
 * times from `fromWall` on: each wall-clock time resolved in the zone, a
 * repeated one to its first occurrence and a skipped one to as much later as
 * the clocks moved. Across a skipped stretch that order is not the order of
 * the instants, and two wall-clock times can resolve to one instant. Throws
 * as `Cron.next` does.
 */
function* wallRuns(
  compiled: Compiled,
  fromWall: number,
): Generator<{ readonly wall: number; readonly at: number }, never> {
  let wall = fromWall;
  while (true) {
    wall = Cron.next(compiled.wall, wall).getTime();
    const at = DateTime.makeZonedUnsafe(wall, {
      timeZone: compiled.zone,
      adjustForTimeZone: true,
      disambiguation: "compatible",
    });
    yield { wall, at: DateTime.toEpochMillis(at) };
  }
}

/** The schedule's first run strictly after `after`. */
const firstAfter = (compiled: Compiled, after: DateTime.Utc) =>
  search(() => {
    const from = DateTime.toEpochMillis(after);
    let first: number | undefined;
    for (const run of wallRuns(compiled, from - WALL_MARGIN_MILLIS)) {
      // No later wall-clock time can resolve before the run found.
      if (first !== undefined && run.wall > first + WALL_MARGIN_MILLIS) break;
      if (run.at > from && (first === undefined || run.at < first)) first = run.at;
    }
    return first;
  }).pipe(
    Result.flatMap((first) =>
      first === undefined ? Result.fail(unreadable()) : Result.succeed(DateTime.makeUnsafe(first)),
    ),
  );

/** The schedule's runs strictly after `after` and up to `until`, in order, each once. */
const runsWithin = (compiled: Compiled, after: DateTime.Utc, until: DateTime.Utc) =>
  search(() => {
    const from = DateTime.toEpochMillis(after);
    const to = DateTime.toEpochMillis(until);
    const found = new Set<number>();
    for (const run of wallRuns(compiled, from - WALL_MARGIN_MILLIS)) {
      if (run.wall > to + WALL_MARGIN_MILLIS) break;
      if (run.at > from && run.at <= to) found.add(run.at);
    }
    return [...found].sort((a, b) => a - b).map((at) => DateTime.makeUnsafe(at));
  });

/**
 * The first time the trigger fires strictly after `after`, or `None` when it
 * never will again: a webhook, or a one-time trigger whose time has come.
 * Fails with `Invalid` for a schedule that does not parse, names no date that
 * exists, or names a zone this runtime does not know.
 */
export const nextRun = (
  trigger: RoutineTrigger,
  after: DateTime.Utc,
): Result.Result<Option.Option<DateTime.Utc>, Invalid> => {
  switch (trigger._tag) {
    case "webhook":
      return Result.succeed(Option.none());
    case "once":
      return Result.succeed(
        DateTime.isGreaterThan(trigger.at, after) ? Option.some(trigger.at) : Option.none(),
      );
    case "schedule":
      return Result.flatMap(compile(trigger), (compiled) =>
        Result.map(firstAfter(compiled, after), Option.some),
      );
  }
};

/**
 * The next run of a trigger an enabled routine is saved with, checked as a
 * command must check it: a schedule must parse, name a date that exists and a
 * known zone, and never run twice within five minutes, and a one-time trigger
 * must lie ahead of `now`.
 */
export const plannedRun = Effect.fnUntraced(function* (
  trigger: RoutineTrigger,
  now: DateTime.Utc,
): Effect.fn.Return<Option.Option<DateTime.Utc>, Invalid> {
  if (trigger._tag === "once" && !DateTime.isGreaterThan(trigger.at, now)) {
    return yield* new Invalid({ reason: "schedule" });
  }
  if (trigger._tag !== "schedule") return yield* Effect.fromResult(nextRun(trigger, now));
  const compiled = yield* Effect.fromResult(compile(trigger));
  const first = yield* Effect.fromResult(firstAfter(compiled, now));
  const upcoming = yield* Effect.fromResult(
    runsWithin(compiled, now, DateTime.addDuration(now, SPACING_WINDOW)),
  );
  for (const [index, at] of upcoming.entries()) {
    const previous = upcoming[index - 1];
    if (
      previous !== undefined &&
      Duration.isLessThan(DateTime.distance(previous, at), MIN_SPACING)
    ) {
      return yield* new Invalid({ reason: "schedule" });
    }
  }
  return Option.some(first);
});
