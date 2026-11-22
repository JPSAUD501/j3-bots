// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

/**
 * The server's rules for a routine's trigger, as the `set_routine` stub
 * applies them, so a routine the server would refuse is refused here too.
 *
 * The rules live in `apps/server/src/routines/schedule.ts`, which this package
 * cannot import (the server depends on it), so they are mirrored here, and
 * `schedule.test.ts` runs them on the server's own boundary examples. Mirrored:
 * a schedule is five cron fields read as wall-clock time in the operator's
 * zone, must name a date that exists, and may not run twice within five
 * minutes over the next eight days; a time the clocks repeat runs at its first
 * occurrence and one they skip as much later as they moved. A one-time `at`
 * must name a date and time that exists and lie ahead. The operator's zone is
 * always one the runtime knows here, so the server's check of it is not
 * mirrored.
 */

const MIN_SPACING = Duration.minutes(5);
const SPACING_WINDOW = Duration.days(8);
const WALL_MARGIN_MILLIS = Duration.toMillis(Duration.days(2));

/** A trigger as the server checks it, with its times read in the operator's zone. */
export type Trigger =
  | { readonly _tag: "schedule"; readonly cron: string; readonly zone: DateTime.TimeZone.Named }
  | { readonly _tag: "once"; readonly at: DateTime.Utc }
  | { readonly _tag: "webhook" };

/** Why the server would refuse a trigger. */
export type Refusal = "schedule" | "once-passed";

interface Compiled {
  readonly wall: Cron.Cron;
  readonly zone: DateTime.TimeZone.Named;
}

const search = <A>(run: () => A): Result.Result<A, "schedule"> =>
  Result.try({ try: run, catch: () => "schedule" as const });

const compile = (
  cron: string,
  zone: DateTime.TimeZone.Named,
): Result.Result<Compiled, "schedule"> => {
  if (cron.trim().split(/\s+/).length !== 5) return Result.fail("schedule");
  return Result.flatMap(
    Result.mapError(Cron.parse(cron, "UTC"), () => "schedule" as const),
    (wall) =>
      Result.map(
        search(() => Cron.next(wall, 0)),
        () => ({ wall, zone }),
      ),
  );
};

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

const firstAfter = (compiled: Compiled, after: DateTime.Utc) =>
  search(() => {
    const from = DateTime.toEpochMillis(after);
    let first: number | undefined;
    for (const run of wallRuns(compiled, from - WALL_MARGIN_MILLIS)) {
      if (first !== undefined && run.wall > first + WALL_MARGIN_MILLIS) break;
      if (run.at > from && (first === undefined || run.at < first)) first = run.at;
    }
    return first;
  }).pipe(
    Result.flatMap((first) =>
      first === undefined
        ? Result.fail("schedule" as const)
        : Result.succeed(DateTime.makeUnsafe(first)),
    ),
  );

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

const crowded = (compiled: Compiled, after: DateTime.Utc, until: DateTime.Utc) =>
  search(() => {
    const from = DateTime.toEpochMillis(after);
    const to = DateTime.toEpochMillis(until);
    const spacing = Duration.toMillis(MIN_SPACING);
    const found: Array<number> = [];
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
        return true;
      }
      found.splice(index, 0, run.at);
    }
    return false;
  });

/**
 * The first run of a trigger saved at `now`, as the server plans it: `None`
 * for a webhook, or the reason the server would refuse it.
 */
export const plannedRun = (
  trigger: Trigger,
  now: DateTime.Utc,
): Result.Result<Option.Option<DateTime.Utc>, Refusal> => {
  switch (trigger._tag) {
    case "webhook":
      return Result.succeed(Option.none());
    case "once":
      return DateTime.isGreaterThan(trigger.at, now)
        ? Result.succeed(Option.some(trigger.at))
        : Result.fail("once-passed");
    case "schedule":
      return Result.flatMap(compile(trigger.cron, trigger.zone), (compiled) =>
        Result.flatMap(
          crowded(compiled, now, DateTime.addDuration(now, SPACING_WINDOW)),
          (tooClose) =>
            tooClose
              ? Result.fail("schedule" as const)
              : Result.map(firstAfter(compiled, now), Option.some),
        ),
      );
  }
};

/** A saved schedule's next run strictly after `after`, or `None` when it names no time. */
export const nextScheduled = (
  cron: string,
  zone: DateTime.TimeZone.Named,
  after: DateTime.Utc,
): Option.Option<DateTime.Utc> =>
  Result.getSuccess(Result.flatMap(compile(cron, zone), (compiled) => firstAfter(compiled, after)));

/** A run as your user's clock shows it: the day of the week (0 is Sunday), hour and minute. */
export interface LocalRun {
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

/**
 * Every run of a saved schedule in the week after `after`, as wall-clock time
 * in `zone`, so two cron expressions that run at the same times read the
 * same. Empty when the schedule names no time.
 */
export const weekOfRuns = (
  cron: string,
  zone: DateTime.TimeZone.Named,
  after: DateTime.Utc,
): ReadonlyArray<LocalRun> => {
  const end = DateTime.add(after, { days: 7 });
  const runs: Array<LocalRun> = [];
  let from = after;
  while (true) {
    const next = nextScheduled(cron, zone, from);
    if (Option.isNone(next) || DateTime.isGreaterThan(next.value, end)) return runs;
    const parts = DateTime.toParts(DateTime.setZone(next.value, zone));
    runs.push({ weekday: parts.weekDay, hour: parts.hour, minute: parts.minute });
    from = next.value;
  }
};

const WALL_FIELDS = ["year", "month", "day", "hour", "minute", "second"] as const;

const LOCAL_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/;

/**
 * The instant a `set_routine` `at` names: without an offset, wall-clock time
 * in `zone`; `None` for a date or time that does not exist.
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
