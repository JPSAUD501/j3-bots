// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TelemetryClient, TelemetryIdHash } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { Telemetry } from "./Telemetry.ts";

/**
 * The clients that said what they are (`telemetry.hello`): `client.connected`
 * once a UTC day for each client device, however many sockets it opens.
 * Kept for as long as the server runs: after a restart, a device's first
 * socket that day counts again.
 */
export class TelemetryClients extends Context.Service<
  TelemetryClients,
  { readonly hello: (client: TelemetryClient) => Effect.Effect<void> }
>()("@j3-bots/server/telemetry/Clients/TelemetryClients") {}

export const layer = Layer.effect(
  TelemetryClients,
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const told = yield* Ref.make<ReadonlyMap<TelemetryIdHash, string>>(new Map());
    return TelemetryClients.of({
      hello: Effect.fn("TelemetryClients.hello")(function* (client: TelemetryClient) {
        // Told only while it is sent, so a device that connects the day the switch is turned on counts.
        if (!(yield* telemetry.sending)) return;
        const day = DateTime.formatIsoDateUtc(yield* DateTime.now);
        const first = yield* Ref.modify(told, (each) => {
          if (each.get(client.device) === day) return [false, each] as const;
          // Only today's are kept: a device seen yesterday is told again.
          const today = new Map([...each].filter(([, seen]) => seen === day));
          today.set(client.device, day);
          return [true, today] as const;
        });
        if (first) yield* telemetry.record({ event: "client.connected", properties: {} }, client);
      }),
    });
  }),
);
