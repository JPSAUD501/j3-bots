// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { SettingsStore } from "../settings/SettingsStore.ts";

/**
 * The operator's switch for usage data (`Settings.telemetry.enabled`), as
 * saved. Built under the domain, which records events, and refreshed by the
 * settings once the operator changes it, so it takes effect at once.
 */
export class TelemetrySwitch extends Context.Service<
  TelemetrySwitch,
  {
    readonly enabled: Effect.Effect<boolean>;
    /** The switch now, then each change. */
    readonly changes: Stream.Stream<boolean>;
    /** Reads it again from the saved settings, after the operator changed it. */
    readonly refresh: Effect.Effect<void>;
  }
>()("@j3-bots/server/telemetry/TelemetrySwitch") {}

export const layer = Layer.effect(
  TelemetrySwitch,
  Effect.gen(function* () {
    const store = yield* SettingsStore;
    const read = store.get.pipe(Effect.map((settings) => settings.telemetry?.enabled !== false));
    const current = yield* SubscriptionRef.make(yield* read);
    return TelemetrySwitch.of({
      enabled: SubscriptionRef.get(current),
      changes: SubscriptionRef.changes(current).pipe(Stream.changes),
      refresh: SubscriptionRef.updateEffect(current, () => read),
    });
  }),
);
