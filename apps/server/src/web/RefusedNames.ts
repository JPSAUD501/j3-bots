// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** How many refused names are kept, so a flood of names fills neither the log nor memory. */
export const KEPT_REFUSED_NAMES = 16;

/**
 * The names the client listener refused over plain HTTP since the server
 * started (`isServedHost`), as its log names them, the first
 * `KEPT_REFUSED_NAMES` of them: what `doctor` reads to tell a proxy or a
 * tunnel that serves the server under a name `publicOrigin` does not give.
 * `record` answers whether the name is new and kept, which is when the log
 * says it.
 */
export class RefusedNames extends Context.Service<
  RefusedNames,
  {
    readonly record: (name: string) => Effect.Effect<boolean>;
    readonly names: Effect.Effect<ReadonlyArray<string>>;
  }
>()("@j3-bots/server/web/RefusedNames") {}

export const layer = Layer.effect(
  RefusedNames,
  Effect.gen(function* () {
    const kept = yield* Ref.make<ReadonlyArray<string>>([]);
    return RefusedNames.of({
      record: Effect.fn("RefusedNames.record")((name: string) =>
        Ref.modify(kept, (names) =>
          names.includes(name) || names.length >= KEPT_REFUSED_NAMES
            ? [false, names]
            : [true, [...names, name]],
        ),
      ),
      names: Ref.get(kept),
    });
  }),
);
