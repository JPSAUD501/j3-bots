// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus } from "@j3-bots/contracts";
import { ModelId, ProviderId } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as TestEngine from "@j3-bots/engine-t3/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Domain from "../domain.ts";
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

/**
 * What outlives a server restart: the database, the home and the engine. A
 * restart test builds this once and `Domain.layer` over it twice.
 */
export const machine = engine.pipe(Layer.provideMerge(TestDatabase.layer));

/** The whole domain over a fresh database, a temporary home and the in-memory engine. */
export const layer = Domain.layer.pipe(Layer.provideMerge(machine));
