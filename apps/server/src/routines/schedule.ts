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
 * How many upcoming runs of a schedule are checked against `MIN_SPACING`:
 * over a week of runs at that spacing, so every weekday and both of a week's
 * clock changes are seen.
 */
const SPACING_CHECKS = 2_100;

type Schedule = Extract<RoutineTrigger, { readonly _tag: "schedule" }>;

/** A schedule as `Cron` reads it, or why it cannot be read. */
const cronOf = (trigger: Schedule): Result.Result<Cron.Cron, Invalid> => {
  const zone = DateTime.zoneMakeNamed(trigger.timeZone);
  if (Option.isNone(zone)) return Result.fail(new Invalid({ reason: "time-zone" }));
  // Five fields only: `Cron` also reads a leading seconds field.
  if (trigger.cron.trim().split(/\s+/).length !== 5) {
    return Result.fail(new Invalid({ reason: "schedule" }));
  }
  return Result.mapError(
    Cron.parse(trigger.cron, zone.value),
    () => new Invalid({ reason: "schedule" }),
  );
};

/**
 * The first time the trigger fires strictly after `after`, or `None` when it
 * never will again: a webhook, or a one-time trigger whose time has come.
 * Fails with `Invalid` for a schedule that does not parse or names a zone this
 * runtime does not know.
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
      return Result.map(cronOf(trigger), (cron) =>
        Option.some(DateTime.fromDateUnsafe(Cron.next(cron, DateTime.toDate(after)))),
      );
  }
};

/**
 * The next run of a trigger an enabled routine is saved with, checked as a
 * command must check it: a schedule must parse, name a known zone and never
 * run twice within five minutes, and a one-time trigger must lie ahead of
 * `now`.
 */
export const plannedRun = Effect.fnUntraced(function* (
  trigger: RoutineTrigger,
  now: DateTime.Utc,
): Effect.fn.Return<Option.Option<DateTime.Utc>, Invalid> {
  if (trigger._tag === "once" && !DateTime.isGreaterThan(trigger.at, now)) {
    return yield* new Invalid({ reason: "schedule" });
  }
  if (trigger._tag !== "schedule") return yield* Effect.fromResult(nextRun(trigger, now));
  const cron = yield* Effect.fromResult(cronOf(trigger));
  let previous: DateTime.Utc | undefined;
  let first: DateTime.Utc | undefined;
  let checked = 0;
  for (const date of Cron.sequence(cron, DateTime.toDate(now))) {
    const at = DateTime.fromDateUnsafe(date);
    if (
      previous !== undefined &&
      Duration.isLessThan(DateTime.distance(previous, at), MIN_SPACING)
    ) {
      return yield* new Invalid({ reason: "schedule" });
    }
    first ??= at;
    previous = at;
    if (++checked >= SPACING_CHECKS) break;
  }
  return Option.fromNullishOr(first);
});
