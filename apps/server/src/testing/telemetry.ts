// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TelemetryClient, TelemetryEvent } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { DEFAULT_TELEMETRY_HOST, DEFAULT_TELEMETRY_KEY } from "../telemetry/environment.ts";
import { type ServerDimensions, Telemetry, TelemetryConfig } from "../telemetry/Telemetry.ts";
import * as TelemetrySwitch from "../telemetry/TelemetrySwitch.ts";

/** A fictional server, as tests describe it. */
export const SERVER: ServerDimensions = {
  j3Version: "0.14.0",
  engineVersion: "0.1.13",
  os: "linux",
  arch: "x64",
  installKind: "service",
};

/** A test server's configuration: an environment that lets it send, to nowhere a test does not serve. */
export const configLayer = Layer.succeed(
  TelemetryConfig,
  TelemetryConfig.of({
    environment: { hold: null, host: DEFAULT_TELEMETRY_HOST, key: DEFAULT_TELEMETRY_KEY },
    server: Effect.succeed(SERVER),
  }),
);

/** An event a test's domain recorded, with the client whose request caused it. */
export interface Recorded {
  readonly event: TelemetryEvent;
  readonly client: TelemetryClient | undefined;
}

/** Every event the test's domain recorded, in order, whether the switch is on or off. */
export class RecordedTelemetry extends Context.Service<
  RecordedTelemetry,
  Ref.Ref<ReadonlyArray<Recorded>>
>()("@j3-bots/server/testing/telemetry/RecordedTelemetry") {}

/**
 * Usage data that keeps every event in memory and sends nothing, over the
 * real switch: a test of the domain asserts what it records, and the
 * delivery has tests of its own (`Telemetry.test.ts`).
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<Recorded>>([]);
    const telemetry = Layer.effect(
      Telemetry,
      Effect.gen(function* () {
        const onOff = yield* TelemetrySwitch.TelemetrySwitch;
        return Telemetry.of({
          record: (event, client) => Ref.update(recorded, (all) => [...all, { event, client }]),
          sending: onOff.enabled,
          sent: Effect.succeed([]),
        });
      }),
    );
    return Layer.mergeAll(telemetry, Layer.succeed(RecordedTelemetry, recorded)).pipe(
      Layer.provideMerge(TelemetrySwitch.layer),
    );
  }),
);

/** The events recorded so far, in order. */
export const recorded = Effect.gen(function* () {
  return yield* Ref.get(yield* RecordedTelemetry);
});
