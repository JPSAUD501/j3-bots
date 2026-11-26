// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * How long after a check that timed out (`checkTimedOut`) the adapter has
 * the engine check the provider again: 15 seconds, then 30, then a minute
 * (`RECHECK_DELAYS`), then every five minutes (`RECHECK_EVERY`) for as long
 * as each check times out. A check times out mostly on a machine busy
 * starting everything, as after an update, which is over within a minute or
 * two; the engine itself checks again only every five minutes, and only when
 * something asks for it (`FIRST_CHECK_BUDGET`).
 */
const RECHECK_DELAYS: ReadonlyArray<Duration.Duration> = [
  Duration.seconds(15),
  Duration.seconds(30),
  Duration.minutes(1),
];
const RECHECK_EVERY = Duration.minutes(5);

/** The wait before the check that follows `earlier` checks again. */
const delayAfter = (earlier: number): Duration.Duration => RECHECK_DELAYS[earlier] ?? RECHECK_EVERY;

/**
 * Checks one provider again while its last check reads as timed out.
 * `timedOut` says, each time it may have changed, whether it does. From
 * each time it starts to, `recheck` runs after each of `RECHECK_DELAYS` in
 * turn, then every `RECHECK_EVERY`, and `due` is told when the next one
 * runs. Once it no longer does, or the stream ends, the waiting stops, a
 * check under way included, and `due` is told null. A recheck that fails, as
 * when the engine is not answering, counts as one that timed out: the next
 * waits its turn.
 */
export const recheckWhileTimedOut = <E, R, RecheckError>(
  timedOut: Stream.Stream<boolean, E, R>,
  recheck: Effect.Effect<void, RecheckError>,
  due: (at: DateTime.Utc | null) => Effect.Effect<void>,
): Effect.Effect<void, E, R> => {
  const rechecking = Effect.gen(function* () {
    for (let earlier = 0; ; earlier++) {
      const delay = delayAfter(earlier);
      yield* due(DateTime.addDuration(yield* DateTime.now, delay));
      yield* Effect.sleep(delay);
      yield* Effect.ignore(recheck);
    }
  });
  return timedOut.pipe(
    Stream.changes,
    Stream.switchMap((now) => (now ? Stream.fromEffect(rechecking) : Stream.fromEffect(due(null)))),
    Stream.runDrain,
    Effect.ensuring(due(null)),
  );
};
