// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

/** A store opened for one key: its value, the work that keeps it live, and what to undo on close. */
export interface Opened<V> {
  readonly value: V;
  readonly run: Effect.Effect<void>;
  readonly close: () => void;
}

/**
 * Stores opened on first use and closed when their last user lets go, so two
 * screens showing one conversation share one subscription.
 */
export const makeKeyed = <I, V>(
  scope: Scope.Scope,
  keyOf: (input: I) => string,
  open: (input: I) => Effect.Effect<Opened<V>>,
) => {
  const opened = new Map<
    string,
    {
      readonly value: V;
      readonly fiber: Fiber.Fiber<void>;
      readonly close: () => void;
      users: number;
    }
  >();

  const acquire = (input: I): Effect.Effect<V, never, Scope.Scope> => {
    const key = keyOf(input);
    return Effect.acquireRelease(
      Effect.gen(function* () {
        const existing = opened.get(key);
        if (existing !== undefined) {
          existing.users += 1;
          return existing.value;
        }
        const store = yield* open(input);
        const fiber = yield* Effect.forkIn(store.run, scope);
        opened.set(key, { value: store.value, fiber, close: store.close, users: 1 });
        return store.value;
      }),
      () =>
        Effect.suspend(() => {
          const entry = opened.get(key);
          if (entry === undefined) return Effect.void;
          entry.users -= 1;
          if (entry.users > 0) return Effect.void;
          opened.delete(key);
          entry.close();
          return Fiber.interrupt(entry.fiber);
        }),
    );
  };

  return { acquire, isOpen: (input: I) => opened.has(keyOf(input)) };
};
