// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  defaultModel,
  type EngineStatus,
  type ModelChoice,
  type ProviderId,
} from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** How a bot's runtime is named in its instructions. */
export interface RuntimeLabels {
  /** The model's display name, such as "Claude Opus 5.5". */
  readonly model: string;
  /** The harness, such as "Claude Code". */
  readonly harness: string;
}

const HARNESS_LABELS = { "claude-code": "Claude Code", codex: "Codex" } as const;

/**
 * Whether `status` reports the provider ready. One it does not report, as
 * while the engine is down or right after it started, is not: nothing says it
 * can run a turn.
 */
export const providerReady = (status: EngineStatus, providerId: ProviderId): boolean =>
  status.providers.some(
    (provider) => provider.id === providerId && provider.status._tag === "ready",
  );

/**
 * The model of a bot created without one, in `status` (`defaultModel`). Its
 * hello waits for the provider, and it moves to the default model once that
 * model's provider is ready (`Bots.adoptDefaults`), which is how a bot made on
 * Claude's catalog ends up on ChatGPT when that is the account signed in.
 */
export const defaultModelIn = (status: EngineStatus): Option.Option<ModelChoice> =>
  Option.fromNullishOr(defaultModel(status));

/**
 * The engine's latest status, kept current, for the decisions that read it
 * once rather than follow it: the default model of a new bot (`defaultModelIn`)
 * and the labels in a bot's instructions.
 */
export class EngineState extends Context.Service<
  EngineState,
  {
    readonly current: Effect.Effect<EngineStatus>;
    /** Each status as `current` takes it, starting with the one now. */
    readonly changes: Stream.Stream<EngineStatus>;
    readonly labels: (model: ModelChoice) => Effect.Effect<RuntimeLabels>;
  }
>()("@j3-bots/server/engine/EngineState") {}

export const layer = Layer.effect(
  EngineState,
  Effect.gen(function* () {
    const engine = yield* Engine;
    // The stream starts with the current value, so the first one is the state now.
    const first = yield* Stream.runHead(engine.status);
    const status = yield* SubscriptionRef.make<EngineStatus>(
      Option.getOrElse(first, () => ({
        state: { _tag: "unavailable", reason: "down" },
        pinnedVersion: "unknown",
        providers: [],
      })),
    );
    yield* engine.status.pipe(
      Stream.runForEach((next) => SubscriptionRef.set(status, next)),
      Effect.forkScoped,
    );
    const current = SubscriptionRef.get(status);

    const providerOf = Effect.fn("EngineState.providerOf")(function* (model: ModelChoice) {
      const now = yield* current;
      return Option.fromNullishOr(
        now.providers.find((provider) => provider.id === model.providerId),
      );
    });

    const labels = Effect.fn("EngineState.labels")(function* (model: ModelChoice) {
      const provider = yield* providerOf(model);
      if (Option.isNone(provider)) return { model: model.modelId, harness: model.providerId };
      const named = provider.value.models.find((candidate) => candidate.id === model.modelId);
      return {
        model: named?.name ?? model.modelId,
        harness:
          provider.value.harness === "other"
            ? provider.value.name
            : HARNESS_LABELS[provider.value.harness],
      };
    });

    return EngineState.of({
      current,
      changes: SubscriptionRef.changes(status),
      labels,
    });
  }),
);
