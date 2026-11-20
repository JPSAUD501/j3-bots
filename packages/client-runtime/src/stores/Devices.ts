// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Device, DeviceId, PairingCode } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Connection, type NotPaired } from "../connection/Connection.ts";
import { Actions, intentResult, type IntentResult } from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/**
 * The paired devices. Read when each socket opens and after every change made
 * here; the contract has no subscription for them.
 */
export class Devices extends Context.Service<
  Devices,
  {
    readonly state: Readable<Synced<ReadonlyArray<Device>>>;
    readonly refresh: Effect.Effect<void, NotPaired>;
    /** A code a new client can pair with, shown on this one. */
    readonly startPairing: Effect.Effect<
      { readonly code: PairingCode; readonly expiresAt: DateTime.Utc },
      NotPaired
    >;
    /**
     * Revoking this device itself closes its socket before the answer can
     * arrive: the result is then `not-paired`, and the connection `unpaired`.
     */
    readonly revoke: (deviceId: DeviceId) => Effect.Effect<IntentResult>;
  }
>()("@j3-bots/client-runtime/stores/Devices") {}

export const layer = Layer.effect(
  Devices,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const state = new Cell<Synced<ReadonlyArray<Device>>>(loading);
    const show = (devices: ReadonlyArray<Device>) => Effect.sync(() => state.set(ready(devices)));

    yield* connection
      .eachSession((client) =>
        client["devices.list"]().pipe(
          Effect.flatMap(show),
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => state.update(markStale))),
        ),
      )
      .pipe(Effect.forkScoped);

    const refresh = connection
      .call((client) => client["devices.list"]())
      .pipe(Effect.flatMap(show));

    const revoke = Effect.fn("Devices.revoke")(function* (deviceId: DeviceId) {
      const commandId = yield* actions.commandId;
      const exit = yield* connection
        .call((client) => client["device.revoke"]({ commandId, deviceId }))
        .pipe(Effect.exit);
      const result = intentResult(exit);
      if (result._tag === "done") {
        state.update((current) =>
          current._tag === "ready"
            ? { ...current, value: current.value.filter((device) => device.id !== deviceId) }
            : current,
        );
      }
      return result;
    });

    return Devices.of({
      state,
      refresh,
      startPairing: connection.call((client) => client["pairing.start"]()),
      revoke,
    });
  }),
);
