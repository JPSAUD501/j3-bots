// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Device,
  type DeviceId,
  type PairingCode,
  pairingOrigins,
  ServerOrigin,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { Connection, type NotPaired } from "../connection/Connection.ts";
import { Actions, intentResult, type IntentResult } from "../intents/Actions.ts";
import { ServerAddress } from "../ports.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** How long revoking a device waits for the server's answer. */
const REVOKE_WAIT = Duration.seconds(10);

/**
 * What revoking a device did. `unanswered`: no answer came within ten
 * seconds, so the device may or may not be revoked; the list is read again
 * once the server answers, and shows which.
 */
export type RevokeResult = IntentResult | { readonly _tag: "unanswered" };

/** A code another device can pair with, and where it reaches the server. */
export interface PairingOffer {
  readonly code: PairingCode;
  readonly expiresAt: DateTime.Utc;
  /**
   * The origins a pairing link can carry to another device, best first
   * (`pairingOrigins`): the one this client reaches the server at when it is
   * `https:` or the server offers it, then those the server offers. Empty
   * when there is none.
   */
  readonly origins: ReadonlyArray<ServerOrigin>;
}

const decodeOrigin = Schema.decodeUnknownOption(ServerOrigin);

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
    readonly startPairing: Effect.Effect<PairingOffer, NotPaired>;
    /**
     * Revokes a device, waiting at most ten seconds for the server. Unless it
     * did, the list is read again once connected, which shows what happened.
     * Revoking this device itself closes its socket before the answer can
     * arrive: the result is then `not-paired`, and the connection `unpaired`.
     */
    readonly revoke: (deviceId: DeviceId) => Effect.Effect<RevokeResult>;
  }
>()("@j3-bots/client-runtime/stores/Devices") {}

export const layer = Layer.effect(
  Devices,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const scope = yield* Scope.Scope;
    const current = Option.getOrUndefined(decodeOrigin((yield* ServerAddress).origin.origin));
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
        .pipe(Effect.exit, Effect.timeoutOption(REVOKE_WAIT));
      const result: RevokeResult = Option.match(exit, {
        onNone: () => ({ _tag: "unanswered" }),
        onSome: intentResult,
      });
      if (result._tag === "done") {
        state.update((current) =>
          current._tag === "ready"
            ? { ...current, value: current.value.filter((device) => device.id !== deviceId) }
            : current,
        );
      } else {
        yield* refresh.pipe(Effect.ignore, Effect.forkIn(scope));
      }
      return result;
    });

    return Devices.of({
      state,
      refresh,
      startPairing: connection
        .call((client) => client["pairing.start"]())
        .pipe(
          Effect.map(({ code, expiresAt, origins }) => ({
            code,
            expiresAt,
            origins: pairingOrigins(origins, current),
          })),
        ),
      revoke,
    });
  }),
);
