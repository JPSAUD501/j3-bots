// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { SettingsStore } from "./SettingsStore.ts";

/**
 * The operator's switch for suggested replies (`Settings.suggestReplies`).
 * The engine is given it as a stream (`EngineOptions.suggestReplies`), since
 * the harnesses make the guesses and each costs a request; the server offers
 * none while it is off. Built under the engine and the domain, both of which
 * read it.
 */
export class SuggestReplies extends Context.Service<
  SuggestReplies,
  {
    /** The switch now, then each change. */
    readonly enabled: Stream.Stream<boolean>;
    /** Reads it again from the saved settings, after the operator changed it. */
    readonly refresh: Effect.Effect<void>;
  }
>()("@j3-bots/server/settings/SuggestReplies") {}

export const layer = Layer.effect(
  SuggestReplies,
  Effect.gen(function* () {
    const store = yield* SettingsStore;
    const read = store.get.pipe(Effect.map((settings) => settings.suggestReplies !== false));
    const current = yield* SubscriptionRef.make(yield* read);
    return SuggestReplies.of({
      enabled: SubscriptionRef.changes(current).pipe(Stream.changes),
      refresh: SubscriptionRef.updateEffect(current, () => read),
    });
  }),
);
