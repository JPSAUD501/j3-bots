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

/** Where `value` goes in `sorted`, ascending: the index of the first element not below it. */
const insertionIndex = (sorted: ReadonlyArray<number>, value: number) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? value) < value) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * Whether two of the schedule's runs strictly after `after` and up to `until`
 * fall within `MIN_SPACING` of each other. Two wall-clock times that resolve
 * to one instant are one run. The runs come in the order of their wall-clock
 * times, which across a skipped stretch is not quite the order of their
 * instants, so each is checked against its neighbours among the instants found
 * so far, kept sorted; the search ends at the first pair too close.
 */
const crowded = (compiled: Compiled, after: DateTime.Utc, until: DateTime.Utc) =>
  search(() => {
    const from = DateTime.toEpochMillis(after);
    const to = DateTime.toEpochMillis(until);
    const spacing = Duration.toMillis(MIN_SPACING);
    const found: Array<number> = [];
    let tooClose = false;
    for (const run of wallRuns(compiled, from - WALL_MARGIN_MILLIS)) {
      if (run.wall > to + WALL_MARGIN_MILLIS) break;
      if (run.at <= from || run.at > to) continue;
      const index = insertionIndex(found, run.at);
      const next = found[index];
      if (next === run.at) continue;
      const previous = found[index - 1];
      if (
        (previous !== undefined && run.at - previous < spacing) ||
        (next !== undefined && next - run.at < spacing)
      ) {
        tooClose = true;
        break;
      }
      found.splice(index, 0, run.at);
    }
    return tooClose;
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
 * known zone, and have no two runs within five minutes of each other over the
 * next eight days, and a one-time trigger must lie ahead of `now`.
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
  if (yield* Effect.fromResult(crowded(compiled, now, DateTime.addDuration(now, SPACING_WINDOW)))) {
    return yield* new Invalid({ reason: "schedule" });
  }
  return Option.some(yield* Effect.fromResult(firstAfter(compiled, now)));
});

const WALL_FIELDS = ["year", "month", "day", "hour", "minute", "second"] as const;

/** A date and time as `set_routine` takes it: no zone, or `Z`, or an offset. */
const LOCAL_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/;

/**
 * The instant a date and time names. Without an offset it is wall-clock time
 * in `zone`, resolved as a schedule's times are: a time the clocks repeat is
 * its first occurrence, and a time they skip lies as much later as they
 * moved. `None` for a date or time that does not exist (`2026-02-31T09:00`).
 */
export const localInstant = (
  text: string,
  zone: DateTime.TimeZone.Named,
): Option.Option<DateTime.Utc> => {
  const match = LOCAL_TIME.exec(text);
  if (match === null) return Option.none();
  const part = (index: number) => Number(match[index] ?? "0");
  const fields: Omit<DateTime.DateTime.Parts, "millisecond"> = {
    year: part(1),
    month: part(2),
    day: part(3),
    hour: part(4),
    minute: part(5),
    second: part(6),
  };
  const wall = DateTime.makeUnsafe(fields);
  const read = DateTime.toPartsUtc(wall);
  // A day or an hour past its end rolls over into the next one.
  if (WALL_FIELDS.some((field) => read[field] !== fields[field])) return Option.none();
  if (match[7] !== undefined) return Option.some(wall);
  if (match[8] !== undefined) {
    const [hours, minutes] = [part(9), part(10)];
    if (hours > 23 || minutes > 59) return Option.none();
    const offset = (match[8] === "-" ? -1 : 1) * (hours * 60 + minutes) * 60_000;
    return Option.some(DateTime.makeUnsafe(DateTime.toEpochMillis(wall) - offset));
  }
  const zoned = DateTime.makeZonedUnsafe(DateTime.toEpochMillis(wall), {
    timeZone: zone,
    adjustForTimeZone: true,
    disambiguation: "compatible",
  });
  return Option.some(DateTime.toUtc(zoned));
};
