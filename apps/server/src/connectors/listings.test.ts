// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { makeListings } from "./listings.ts";

describe("listings", () => {
  it.effect(
    "runs a refresh asked for during a listing, though a listing while unlisted is asked for after it",
    () =>
      Effect.gen(function* () {
        const run = yield* makeListings<string>(yield* Effect.scope);
        const ran = yield* Ref.make<ReadonlyArray<string>>([]);
        const first = yield* Deferred.make<void>();
        const done = yield* Deferred.make<void>();
        const listing = (name: string) => Ref.update(ran, (all) => [...all, name]);

        yield* run("tracker", Effect.andThen(Deferred.await(first), listing("first")));
        yield* run(
          "tracker",
          Effect.andThen(listing("refresh"), Deferred.succeed(done, undefined)),
        );
        yield* run("tracker", listing("while-unlisted"), "while-unlisted");
        yield* Deferred.succeed(first, undefined);
        yield* Deferred.await(done);

        assert.deepStrictEqual(yield* Ref.get(ran), ["first", "refresh"]);
      }).pipe(Effect.scoped),
  );
});
