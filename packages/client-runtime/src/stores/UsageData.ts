// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ClientTelemetryEvent,
  ReleaseVersion,
  type SentTelemetryEvent,
  type Settings as SettingsValue,
  type TelemetryClient,
  telemetryIdHash,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Connection, type J3RpcClient } from "../connection/Connection.ts";
import { intentResult, type IntentResult } from "../intents/Actions.ts";
import { ClientIdentity } from "../ports.ts";
import { waitFor } from "../Store.ts";
import { Settings } from "./Settings.ts";

// Usage data (decision 0099) is the server's: a client loads no analytics
// library and sends nothing anywhere else. It tells its own server what it
// is on each socket, and the few things only it sees, while the operator's
// switch is on.

/** Whether the server takes usage data and sends it now, by the settings it holds. */
export const usageDataOn = (settings: SettingsValue): boolean =>
  settings.telemetry !== undefined && settings.telemetry.enabled && !settings.telemetry.heldOff;

export class UsageData extends Context.Service<
  UsageData,
  {
    /** What this client tells its server it is: never more than `TelemetryClient` says. */
    readonly client: Effect.Effect<TelemetryClient>;
    /**
     * Tells the server something the operator did that only this client
     * sees, while usage data is on; nothing otherwise, or on a server
     * without it. Never fails; waits for a socket `RECORD_WAIT` at most.
     */
    readonly record: (event: ClientTelemetryEvent) => Effect.Effect<void>;
    /** The newest events the server sent, exactly as they left, newest first. */
    readonly sent: Effect.Effect<IntentResult<ReadonlyArray<SentTelemetryEvent>>>;
  }
>()("@j3-bots/client-runtime/stores/UsageData") {}

/** How long an event waits for a socket before it is dropped. */
export const RECORD_WAIT = "10 seconds";

const decodeVersion = Schema.decodeUnknownOption(ReleaseVersion);

export const layer = Layer.effect(
  UsageData,
  Effect.gen(function* () {
    const identity = yield* ClientIdentity;
    const connection = yield* Connection;
    const settings = yield* Settings;

    const client = Effect.cached(
      Effect.gen(function* () {
        const version = yield* identity.version;
        return {
          surface: identity.surface,
          os: identity.os,
          version: Option.getOrNull(decodeVersion(version)),
          device: telemetryIdHash(yield* identity.randomId),
        } satisfies TelemetryClient;
      }),
    );
    const told = yield* client;

    const record = Effect.fn("UsageData.record")(function* (event: ClientTelemetryEvent) {
      const now = settings.state.get();
      if (now._tag !== "ready" || !usageDataOn(now.value)) return;
      // Not worth holding long for a socket: a moment's usage is dropped after a while.
      yield* connection
        .call((rpc) => rpc["telemetry.record"]({ event }))
        .pipe(Effect.timeout(RECORD_WAIT), Effect.ignoreCause);
    });

    const sent = connection
      .call((rpc) => rpc["telemetry.sent"]())
      .pipe(Effect.exit, Effect.map(intentResult));

    /**
     * Says what this client is on each socket, once the settings it read say
     * the server takes usage data: the server adds it to the events the
     * socket's requests cause. A failure changes nothing here.
     */
    const hello = (rpc: J3RpcClient) =>
      waitFor(settings.state, (state) => state._tag === "ready" && !state.stale).pipe(
        Effect.flatMap((state) =>
          state._tag === "ready" && state.value.telemetry !== undefined
            ? told.pipe(Effect.flatMap((each) => rpc["telemetry.hello"]({ client: each })))
            : Effect.void,
        ),
        Effect.ignoreCause,
      );
    yield* connection.eachSession(hello).pipe(Effect.forkScoped);

    return UsageData.of({ client: told, record, sent });
  }),
);
