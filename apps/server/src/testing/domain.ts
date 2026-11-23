// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus, ProviderStatus } from "@j3-bots/contracts";
import { ModelId, ProviderId } from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as TestEngine from "@j3-bots/engine-t3/testing";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ListenerStatus } from "../admin/protocol.ts";
import * as Domain from "../domain.ts";
import * as Listener from "../listener.ts";
import type { PushSender } from "../push/PushSender.ts";
import * as BasePrompt from "../settings/BasePrompt.ts";
import * as SettingsStore from "../settings/SettingsStore.ts";
import * as TestDatabase from "./database.ts";
import * as TestPush from "./push.ts";

/** The model a bot gets by default: the first the test engine offers. */
export const DEFAULT_MODEL = {
  providerId: ProviderId.make("claude"),
  modelId: ModelId.make("opus"),
};

/** A model of a second provider, which a bot can move to. */
export const OTHER_PROVIDER_MODEL = {
  providerId: ProviderId.make("codex"),
  modelId: ModelId.make("gpt"),
};

const providers: EngineStatus["providers"] = [
  {
    id: DEFAULT_MODEL.providerId,
    name: "Claude",
    harness: "claude-code",
    status: { _tag: "ready" },
    models: [{ id: DEFAULT_MODEL.modelId, name: "Claude Opus" }],
    usage: [],
  },
  {
    id: OTHER_PROVIDER_MODEL.providerId,
    name: "Codex",
    harness: "codex",
    status: { _tag: "ready" },
    models: [{ id: OTHER_PROVIDER_MODEL.modelId, name: "GPT" }],
    usage: [],
  },
];

/** The providers the test engine reports, whose state a test can change. */
export class TestProviders extends Context.Service<
  TestProviders,
  {
    readonly current: Stream.Stream<EngineStatus["providers"]>;
    /** The engine reports the provider in this state from now on. */
    readonly setStatus: (
      providerId: ProviderId,
      status: ProviderStatus["status"],
    ) => Effect.Effect<void>;
    /** The engine lists these models of the provider from now on. */
    readonly setModels: (
      providerId: ProviderId,
      models: ProviderStatus["models"],
    ) => Effect.Effect<void>;
  }
>()("@j3-bots/server/testing/domain/TestProviders") {}

/** Which state a provider is reported in as the engine starts, by id; ready when not named. */
type StartingStatuses = ReadonlyMap<ProviderId, ProviderStatus["status"]>;

const testProviders = (starting: StartingStatuses) =>
  Layer.effect(
    TestProviders,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(
        providers.map((provider) => ({
          ...provider,
          status: starting.get(provider.id) ?? provider.status,
        })),
      );
      const change = (providerId: ProviderId, changed: Partial<ProviderStatus>) =>
        SubscriptionRef.update(ref, (all) =>
          all.map((provider) =>
            provider.id === providerId ? { ...provider, ...changed } : provider,
          ),
        );
      return TestProviders.of({
        current: SubscriptionRef.changes(ref),
        setStatus: (providerId, status) => change(providerId, { status }),
        setModels: (providerId, models) => change(providerId, { models }),
      });
    }),
  );

/**
 * The in-memory engine, offering a Claude Code and a Codex provider, both
 * ready until a test says otherwise. The test engine reports no providers of
 * its own, and a bot needs a model to exist.
 */
const engineWith = (starting: StartingStatuses) =>
  Layer.effect(
    Engine,
    Effect.gen(function* () {
      const inner = yield* Engine;
      const reported = yield* TestProviders;
      return Engine.of({
        ...inner,
        status: inner.status.pipe(
          Stream.zipLatestWith(reported.current, (status, now) => ({ ...status, providers: now })),
        ),
      });
    }),
  ).pipe(Layer.provideMerge(Layer.merge(TestEngine.layer, testProviders(starting))));

/** The database `database` gives, the home and the engine, its providers as `starting` says. */
const storesOver = (database: typeof TestDatabase.layer, starting: StartingStatuses) =>
  Layer.mergeAll(
    engineWith(starting),
    BasePrompt.layer.pipe(Layer.provide(SettingsStore.layer)),
  ).pipe(Layer.provideMerge(database));

const stores = storesOver(TestDatabase.layer, new Map());

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
 * What outlives a server restart, with `push` as the push sender: the
 * database, the home, the engine, the push service and where clients reach
 * it. A restart test builds this once and `Domain.layer` over it twice.
 */
export const machineWith = <A, R>(push: Layer.Layer<A | PushSender, never, R>) =>
  Layer.mergeAll(stores, listener, push);

/** What outlives a server restart, with the in-memory push service. */
export const machine = machineWith(TestPush.layer);

/**
 * The whole domain over a fresh database, a temporary home, the in-memory
 * engine and the in-memory push service.
 */
export const layer = Domain.layer.pipe(Layer.provideMerge(machine));

/**
 * The whole domain over the database `database` gives, as one an earlier
 * release left (`TestDatabase.layerAfter`), with the in-memory engine, whose
 * providers start as `starting` says, and push service.
 */
export const layerOver = (database: typeof TestDatabase.layer, starting: StartingStatuses) =>
  Domain.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(storesOver(database, starting), listener, TestPush.layer)),
  );

/**
 * The whole domain, for a test that serves it on the client listener
 * (`Listener.layer`), which reports where it bound.
 */
export const servedLayer = Domain.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(stores, Listener.unbound, TestPush.layer)),
);
