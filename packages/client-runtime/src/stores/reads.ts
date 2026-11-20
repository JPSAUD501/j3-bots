// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NotFound } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as Scope from "effect/Scope";
import type { Connection, J3RpcClient } from "../connection/Connection.ts";
import { Cell, type Readable } from "../Store.ts";
import { makeKeyed } from "./keyed.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** Server state about one object, which may have been deleted. */
export type Loaded<A> = Synced<A> | { readonly _tag: "not-found" };

const stale = <A>(loaded: Loaded<A>): Loaded<A> =>
  loaded._tag === "not-found" ? loaded : markStale(loaded);

/**
 * Values opened per key while someone holds them, each kept live by `follow`
 * on every socket: a read that then holds, or a subscription. `follow` calls
 * `set` with each new value, worked out from the one held, if any. `NotFound`
 * from the server ends it as `not-found`.
 */
export const makeLive = <I, A>(options: {
  readonly scope: Scope.Scope;
  readonly connection: Connection["Service"];
  readonly keyOf: (input: I) => string;
  readonly follow: (
    input: I,
    client: J3RpcClient,
    set: (next: (current: A | null) => A) => Effect.Effect<void>,
  ) => Effect.Effect<void, NotFound | RpcClientError>;
}) =>
  makeKeyed(options.scope, options.keyOf, (input: I) =>
    Effect.sync(() => {
      const state = new Cell<Loaded<A>>(loading);
      const set = (next: (current: A | null) => A) =>
        Effect.sync(() => {
          const current = state.get();
          state.set(ready(next(current._tag === "ready" ? current.value : null)));
        });
      const run = options.connection
        .eachSession((client) =>
          options
            .follow(input, client, set)
            .pipe(Effect.ensuring(Effect.sync(() => state.update(stale)))),
        )
        .pipe(
          Effect.catchTag("NotFound", () => Effect.sync(() => state.set({ _tag: "not-found" }))),
        );
      const readable: Readable<Loaded<A>> = state;
      return { value: readable, run, close: () => {} };
    }),
  );
