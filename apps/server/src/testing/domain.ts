// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus } from "@j3-bots/contracts";
import { ModelId, ProviderId } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as TestEngine from "@j3-bots/engine-t3/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { ListenerStatus } from "../admin/protocol.ts";
import * as Domain from "../domain.ts";
import * as Listener from "../listener.ts";
import * as TestDatabase from "./database.ts";

/** The one model the test engine offers. */
const MODEL = { providerId: ProviderId.make("claude"), modelId: ModelId.make("opus") };

const provider: EngineStatus["providers"][number] = {
  id: MODEL.providerId,
  name: "Claude",
  harness: "claude-code",
  status: { _tag: "ready" },
  models: [{ id: MODEL.modelId, name: "Claude Opus" }],
  usage: [],
};

/**
 * The in-memory engine, offering one ready Claude Code provider. The test
 * engine reports no providers of its own, and a bot needs a model to exist.
 */
const engine = Layer.effect(
  Engine,
  Effect.gen(function* () {
    const inner = yield* Engine;
    return Engine.of({
      ...inner,
      status: inner.status.pipe(Stream.map((status) => ({ ...status, providers: [provider] }))),
    });
  }),
).pipe(Layer.provideMerge(TestEngine.layer));

/** The database, the home and the engine. */
const stores = engine.pipe(Layer.provideMerge(TestDatabase.layer));

/**
 * The client listener as a server of the default configuration reports it,
 * for the tests that serve no listener of their own: every IPv4 interface, on
 * port 3737.
 */
const listener = Layer.effect(
  Listener.Listener,
  Effect.tap(Deferred.make<ListenerStatus>(), (bound) =>
    Deferred.succeed(bound, { scheme: "http", address: "0.0.0.0", port: 3737, names: [] }),
  ),
);

/**
 * What outlives a server restart: the database, the home, the engine and
 * where clients reach it. A restart test builds this once and `Domain.layer`
 * over it twice.
 */
export const machine = Layer.merge(stores, listener);

/** The whole domain over a fresh database, a temporary home and the in-memory engine. */
export const layer = Domain.layer.pipe(Layer.provideMerge(machine));

/**
 * The whole domain, for a test that serves it on the client listener
 * (`Listener.layer`), which reports where it bound.
 */
export const servedLayer = Domain.layer.pipe(
  Layer.provideMerge(Layer.merge(stores, Listener.unbound)),
);
