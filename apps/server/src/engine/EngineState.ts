// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus, ModelChoice, PermissionMode } from "@j3-bots/contracts";
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
 * Which provider a new bot lands on when none is named, lowest first: one
 * that runs it now, one that will once its limit resets, one a command
 * connects, and last one the engine cannot run yet, such as while it checks.
 */
const defaultRank = {
  ready: 0,
  limited: 1,
  "sign-in-required": 2,
  unavailable: 3,
} as const satisfies Record<EngineStatus["providers"][number]["status"]["_tag"], number>;

/**
 * The engine's latest status, kept current, for the decisions that read it
 * once rather than follow it: the default model of a new bot and the labels in
 * a bot's instructions.
 */
export class EngineState extends Context.Service<
  EngineState,
  {
    readonly current: Effect.Effect<EngineStatus>;
    /** Each status as `current` takes it, starting with the one now. */
    readonly changes: Stream.Stream<EngineStatus>;
    /**
     * The model of a bot created without one: the first model of the first
     * ready provider; with none ready, of the first that lists a model,
     * preferring one that only needs connecting. A first bot is never
     * refused for want of a connected provider: its hello waits for one.
     */
    readonly defaultModel: Effect.Effect<Option.Option<ModelChoice>>;
    /**
     * Supervised unless the provider is known to take Auto. The engine's
     * reviewer exists on Claude Code and Codex; **Assumed** for any other harness.
     */
    readonly defaultPermissionMode: (model: ModelChoice) => Effect.Effect<PermissionMode>;
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

    const defaultPermissionMode = Effect.fn("EngineState.defaultPermissionMode")(function* (
      model: ModelChoice,
    ) {
      const provider = yield* providerOf(model);
      return Option.isSome(provider) && provider.value.harness !== "other"
        ? ("auto" as const)
        : ("supervised" as const);
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
      defaultModel: current.pipe(
        Effect.map((now) => {
          let best: { readonly rank: number; readonly model: ModelChoice } | null = null;
          for (const provider of now.providers) {
            const model = provider.models[0];
            if (model === undefined) continue;
            const rank = defaultRank[provider.status._tag];
            if (best === null || rank < best.rank) {
              best = { rank, model: { providerId: provider.id, modelId: model.id } };
            }
          }
          return Option.fromNullishOr(best?.model);
        }),
      ),
      defaultPermissionMode,
      labels,
    });
  }),
);
