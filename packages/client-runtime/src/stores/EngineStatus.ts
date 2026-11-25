// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus as EngineStatusValue, ProviderId } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import { intentResult, type IntentResult } from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** The engine and its providers, as the server reports them. */
export class EngineStatus extends Context.Service<
  EngineStatus,
  {
    readonly state: Readable<Synced<EngineStatusValue>>;
    /**
     * Has the engine check the provider again now; done once it took the
     * request. What it finds follows on `state`.
     */
    readonly recheck: (providerId: ProviderId) => Effect.Effect<IntentResult<void>>;
  }
>()("@j3-bots/client-runtime/stores/EngineStatus") {}

export const layer = Layer.effect(
  EngineStatus,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const state = new Cell<Synced<EngineStatusValue>>(loading);
    yield* connection
      .eachSession((client) =>
        client["engine.subscribe"]().pipe(
          Stream.runForEach((status) => Effect.sync(() => state.set(ready(status)))),
          Effect.ensuring(Effect.sync(() => state.update(markStale))),
        ),
      )
      .pipe(Effect.forkScoped);
    const recheck = (providerId: ProviderId) =>
      connection
        .call((client) => client["engine.recheckProvider"]({ providerId }))
        .pipe(Effect.exit, Effect.map(intentResult));
    return EngineStatus.of({ state, recheck });
  }),
);
