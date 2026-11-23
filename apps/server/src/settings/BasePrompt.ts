// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderBaseInstructions } from "@j3-bots/prompts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { SettingsStore } from "./SettingsStore.ts";

/**
 * The base prompt every bot shares, rendered for the operator's name. The
 * engine is given it as a stream (`EngineOptions.basePrompt`), because Codex
 * takes it once per provider instance rather than from each bot's files.
 * Built under the engine and the domain, both of which read it.
 */
export class BasePrompt extends Context.Service<
  BasePrompt,
  {
    /** The text now, then each change. */
    readonly text: Stream.Stream<string>;
    /** Renders it again from the saved settings, after the operator's name changed. */
    readonly refresh: Effect.Effect<void>;
  }
>()("@j3-bots/server/settings/BasePrompt") {}

export const layer = Layer.effect(
  BasePrompt,
  Effect.gen(function* () {
    const store = yield* SettingsStore;
    const render = store.get.pipe(
      Effect.map((settings) => renderBaseInstructions({ name: settings.operatorName })),
    );
    const current = yield* SubscriptionRef.make(yield* render);
    return BasePrompt.of({
      text: SubscriptionRef.changes(current).pipe(Stream.changes),
      // The read holds the ref's permit, so two refreshes close together
      // leave the later name's text.
      refresh: SubscriptionRef.updateEffect(current, () => render),
    });
  }),
);
