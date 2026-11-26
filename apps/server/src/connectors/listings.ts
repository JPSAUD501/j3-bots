// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

/**
 * When a listing asked for while another runs is worth running after it:
 * always, or only while the connector is still unlisted, which a listing
 * queued before it settles as well.
 */
export type ListingWhen = "always" | "while-unlisted";

/**
 * Runs each key's listings in the background, one at a time. A listing
 * asked for while one runs is run once after it, the last asked for in
 * place of any before, except that one asked for `while-unlisted` never
 * takes a queued one's place: that one lists too, and may be a refresh the
 * connector asked for, which nothing else would run.
 */
export const makeListings = Effect.fn("makeListings")(function* <Key>(scope: Scope.Scope) {
  /** The keys being listed, each with the listing asked for next, if any. */
  const flights = yield* Ref.make<ReadonlyMap<Key, Option.Option<Effect.Effect<void>>>>(new Map());

  const drain = (key: Key, list: Effect.Effect<void>): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* list;
      // Taking the next listing and ending the flight are one step, so no request falls between.
      const next = yield* Ref.modify(
        flights,
        (
          all,
        ): [
          Option.Option<Effect.Effect<void>>,
          ReadonlyMap<Key, Option.Option<Effect.Effect<void>>>,
        ] => {
          const queued = all.get(key) ?? Option.none();
          const rest = new Map(all);
          if (Option.isSome(queued)) rest.set(key, Option.none());
          else rest.delete(key);
          return [queued, rest];
        },
      );
      if (Option.isSome(next)) yield* drain(key, next.value);
    });

  return Effect.fn("Listings.run")(function* (
    key: Key,
    list: Effect.Effect<void>,
    when: ListingWhen = "always",
  ) {
    const started = yield* Ref.modify(
      flights,
      (all): [boolean, ReadonlyMap<Key, Option.Option<Effect.Effect<void>>>] => {
        const flight = all.get(key);
        if (flight === undefined) return [true, new Map(all).set(key, Option.none())];
        if (when === "while-unlisted" && Option.isSome(flight)) return [false, all];
        return [false, new Map(all).set(key, Option.some(list))];
      },
    );
    if (!started) return;
    yield* drain(key, list).pipe(
      Effect.onError(() =>
        Ref.update(flights, (all) => {
          const next = new Map(all);
          next.delete(key);
          return next;
        }),
      ),
      Effect.forkIn(scope),
    );
  });
});
