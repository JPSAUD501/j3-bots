// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus, ModelChoice, ProviderId } from "@j3-bots/contracts";
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
 * connects, one the engine is still checking, and last one whose harness is
 * not installed yet. J3 Bots installs a missing harness itself once a client
 * asks for it (docs/decisions/0045-j3-bots-keeps-its-own-copies-of-the-harnesses.md),
 * which every screen that shows the bot waiting offers, and the engine lists
 * Claude Code's catalog even before it is there (**Read** at `59651c1`,
 * `checkClaudeProviderStatus` in `ClaudeProvider.ts`), so the operator's
 * first bot is made while its AI still downloads, and says hello once it
 * runs. One the engine found and cannot run, as a harness that
 * failed to start or a provider turned off, never: a bot put on it would
 * wait for a provider nothing is bringing.
 */
const defaultRank = (status: EngineStatus["providers"][number]["status"]): number | null => {
  switch (status._tag) {
    case "ready":
      return 0;
    case "limited":
      return 1;
    case "sign-in-required":
      return 2;
    case "unavailable":
      if (status.checking) return 3;
      return status.reason === "not-installed" ? 4 : null;
  }
};

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
 * The model of a bot created without one, in `status`: the first model of the
 * first ready provider; with none ready, of the first that lists a model and
 * may still run it, as `defaultRank` orders them. A first bot is not refused
 * for want of a connected provider, or of one still being downloaded: its
 * hello waits for one, and it moves to the default model once that model's
 * provider is ready (`Bots.adoptDefaults`), which is how a bot made on
 * Claude's catalog ends up on ChatGPT when that is the account signed in.
 */
export const defaultModelIn = (status: EngineStatus): Option.Option<ModelChoice> => {
  let best: { readonly rank: number; readonly model: ModelChoice } | null = null;
  for (const provider of status.providers) {
    const model = provider.models[0];
    if (model === undefined) continue;
    const rank = defaultRank(provider.status);
    if (rank === null) continue;
    if (best === null || rank < best.rank) {
      best = { rank, model: { providerId: provider.id, modelId: model.id } };
    }
  }
  return Option.fromNullishOr(best?.model);
};

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
