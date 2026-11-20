// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus as EngineStatusValue } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** The engine and its providers, as the server reports them. */
export class EngineStatus extends Context.Service<
  EngineStatus,
  { readonly state: Readable<Synced<EngineStatusValue>> }
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
    return EngineStatus.of({ state });
  }),
);
