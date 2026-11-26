// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class HungUp extends Schema.TaggedError<HungUp>()("HungUp", {}) {}

/** Fails once this process's terminal hangs up (`SIGHUP`). */
const hangup = Effect.callback<never, HungUp>((resume) => {
  const hangUp = () => resume(Effect.fail(new HungUp()));
  process.once("SIGHUP", hangUp);
  return Effect.sync(() => process.off("SIGHUP", hangUp));
});

/**
 * Runs `effect`, interrupted when this process's terminal hangs up, as when
 * an SSH connection drops. Node's own answer to `SIGHUP` is to exit at once,
 * so what `effect` cleans up when it ends, such as a folder a sign-in made,
 * would stay behind; interrupted, it ends the way Ctrl+C ends it. The
 * command's output after that goes to a terminal that is gone, which Node's
 * console drops.
 */
export const endedOnHangup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.raceFirst(effect, hangup).pipe(Effect.catchIf(Schema.is(HungUp), () => Effect.interrupt));
