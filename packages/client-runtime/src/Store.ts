// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";

/**
 * A value that changes over time, read synchronously and watched with a
 * listener. This is the whole interface a UI framework needs: React reads it
 * with `useSyncExternalStore`, and any other renderer with a callback.
 */
export interface Readable<A> {
  readonly get: () => A;
  /** Calls `listener` after every change. Returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** A `Readable` its owner writes. Setting an identical value notifies nobody. */
export class Cell<A> implements Readable<A> {
  #value: A;
  readonly #listeners = new Set<() => void>();

  constructor(initial: A) {
    this.#value = initial;
  }

  readonly get = (): A => this.#value;

  readonly set = (value: A): void => {
    if (Object.is(value, this.#value)) return;
    this.#value = value;
    for (const listener of this.#listeners) listener();
  };

  readonly update = (f: (current: A) => A): void => this.set(f(this.#value));

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

/** The first value of `readable` that satisfies `predicate`: the current one, or a later one. */
export const waitFor: {
  <A, B extends A>(readable: Readable<A>, predicate: (value: A) => value is B): Effect.Effect<B>;
  <A>(readable: Readable<A>, predicate: (value: A) => boolean): Effect.Effect<A>;
} = <A>(readable: Readable<A>, predicate: (value: A) => boolean) =>
  Effect.callback<A>((resume) => {
    const check = () => {
      const value = readable.get();
      if (!predicate(value)) return false;
      unsubscribe();
      resume(Effect.succeed(value));
      return true;
    };
    const unsubscribe = readable.subscribe(check);
    check();
    return Effect.sync(unsubscribe);
  });
