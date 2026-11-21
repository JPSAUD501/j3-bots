// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

interface Entry {
  readonly lock: Semaphore.Semaphore;
  /** The effects holding or waiting for the lock: the entry goes when the last leaves. */
  users: number;
}

/**
 * One serial lock per key, held in the process. Only keys with an effect in
 * flight have an entry, so a key that is done with (a retired session, a
 * closed card) leaves nothing behind.
 */
export const keyedLock = () => {
  const entries = new Map<string, Entry>();
  /** Runs `effect` holding the key's lock. */
  const run =
    (key: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const entry = entries.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
        entry.users += 1;
        entries.set(key, entry);
        return entry.lock
          .withPermits(1)(effect)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.users -= 1;
                if (entry.users === 0) entries.delete(key);
              }),
            ),
          );
      });
  /** How many effects hold the key's lock or wait for it. */
  const users = (key: string) => Effect.sync(() => entries.get(key)?.users ?? 0);
  return { run, users };
};
