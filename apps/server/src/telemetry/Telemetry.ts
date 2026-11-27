// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_SENT_TELEMETRY_EVENTS,
  SentTelemetryEvent,
  type TelemetryArch,
  type TelemetryClient,
  type TelemetryEvent,
  type TelemetryInstallKind,
  type TelemetryOs,
} from "@j3-bots/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { TelemetryEnvironment } from "./environment.ts";
import { TelemetryStore } from "./TelemetryStore.ts";
import { TelemetrySwitch } from "./TelemetrySwitch.ts";

// Delivery of the server's usage data to PostHog's batch API, without its SDK:
// a few HTTP requests do not need one, and the SDK would bring its own queue,
// timers and retries to keep in step with the server's stop. The shape of it
// (a UUID per event, batches, backoff, a bounded buffer, a batch dropped after
// bounded retries, a shutdown flush bounded in time) follows T3 Code's
// `apps/server/src/telemetry/AnalyticsService.ts` at `bc0f04d` (MIT).

/** What the server says about itself in every event. */
export interface ServerDimensions {
  readonly j3Version: string;
  /** Null for an engine build under test, which is not the pinned release. */
  readonly engineVersion: string | null;
  readonly os: TelemetryOs;
  readonly arch: TelemetryArch;
  readonly installKind: TelemetryInstallKind;
}

/** The environment's rules and the server's dimensions, read once at start. */
export class TelemetryConfig extends Context.Service<
  TelemetryConfig,
  {
    readonly environment: TelemetryEnvironment;
    readonly server: Effect.Effect<ServerDimensions>;
  }
>()("@j3-bots/server/telemetry/Telemetry/TelemetryConfig") {}

/** How delivery paces itself; tests make it quicker. */
export interface DeliveryTiming {
  /** How often waiting events are sent. */
  readonly interval: number;
  /** The longest a request may take before it counts as failed. */
  readonly sendTimeout: number;
  /** The longest the server's stop waits to send what is waiting; the rest is dropped. */
  readonly shutdownFlush: number;
  /** The first wait after a failed batch, doubled with each failure in a row. */
  readonly retryBase: number;
  readonly retryMax: number;
}

const DEFAULT_TIMING: DeliveryTiming = {
  interval: 10_000,
  sendTimeout: 10_000,
  shutdownFlush: 1_000,
  retryBase: 2_000,
  retryMax: 300_000,
};

/** The most events one request carries. */
const BATCH_SIZE = 50;
/** The most events waiting to be sent; past it the oldest go. */
const MAX_BUFFERED_EVENTS = 1_000;
/** How many times a batch is tried before it is dropped. */
export const MAX_BATCH_ATTEMPTS = 6;
/** Answers that refuse the batch itself, where trying it again cannot help. */
const REFUSED_BATCH_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 413]);

interface Waiting {
  readonly uuid: string;
  readonly at: DateTime.Utc;
  readonly event: TelemetryEvent;
  readonly client: TelemetryClient | undefined;
}

interface Delivery {
  /**
   * Counts the times the switch went off. A send that started under another
   * leaves nothing behind it: what it carried was dropped with the rest.
   */
  readonly epoch: number;
  /** The batch that failed, sent again before anything newer. */
  readonly failed: ReadonlyArray<Waiting>;
  readonly attempts: number;
  /** Failures in a row, across batches, which set the next wait. */
  readonly failures: number;
  readonly retryAt: number;
}

const idle = (epoch: number): Delivery => ({
  epoch,
  failed: [],
  attempts: 0,
  failures: 0,
  retryAt: 0,
});

/** The wait before the next try, after `failures` in a row; `random` is in [0, 1). */
const retryDelay = (timing: DeliveryTiming, failures: number, random: number): number => {
  const ceiling = Math.min(timing.retryMax, timing.retryBase * 2 ** (failures - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
};

// It takes the event as an unknown value and checks it whole: what does not match a
// declared event, or carries a property it does not declare, never leaves.
const encodeSent = Schema.encodeUnknownEffect(Schema.toCodecJson(SentTelemetryEvent), {
  onExcessProperty: "error",
});
const decodeSent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(SentTelemetryEvent)),
);

/**
 * The server's usage data. Events are kept in memory and sent in batches
 * while the environment allows it and the operator's switch is on; turning
 * the switch off drops what waits. Sending never fails anything else: an
 * event that cannot be sent is dropped.
 */
export class Telemetry extends Context.Service<
  Telemetry,
  {
    /**
     * Queues `event` to be sent, with what `client` said of itself when the
     * request that caused it came from one. Nothing while it is off.
     */
    readonly record: (event: TelemetryEvent, client?: TelemetryClient) => Effect.Effect<void>;
    /** Whether events are being sent now. */
    readonly sending: Effect.Effect<boolean>;
    /** The newest events sent, exactly as they left, newest first. */
    readonly sent: Effect.Effect<ReadonlyArray<SentTelemetryEvent>>;
  }
>()("@j3-bots/server/telemetry/Telemetry") {}

const make = Effect.fn("Telemetry.make")(function* (timing: DeliveryTiming) {
  const config = yield* TelemetryConfig;
  const store = yield* TelemetryStore;
  const onOff = yield* TelemetrySwitch;
  const http = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const { environment } = config;
  const install = yield* store.install;
  const buffer = yield* Ref.make<ReadonlyArray<Waiting>>([]);
  const delivery = yield* Ref.make<Delivery>(idle(0));
  // The background flush and the stop's must not send one batch twice.
  const lock = yield* Semaphore.make(1);

  const sending = Effect.map(onOff.enabled, (enabled) => enabled && environment.hold === null);

  // What the server says of itself is read only once there is something to send.
  const asSent = (waiting: Waiting, server: ServerDimensions) =>
    encodeSent({
      uuid: waiting.uuid,
      event: waiting.event.event,
      distinct_id: install,
      timestamp: waiting.at,
      properties: {
        ...waiting.event.properties,
        installId: install,
        $process_person_profile: false,
        $geoip_disable: true,
        j3Version: server.j3Version,
        engineVersion: server.engineVersion,
        os: server.os,
        arch: server.arch,
        installKind: server.installKind,
        ...(waiting.client === undefined
          ? {}
          : {
              surface: waiting.client.surface,
              clientVersion: waiting.client.version,
              clientOs: waiting.client.os,
              clientDevice: waiting.client.device,
            }),
      },
    });

  const send = Effect.fn("Telemetry.send")(function* (batch: ReadonlyArray<Waiting>) {
    const server = yield* config.server;
    const encoded = yield* Effect.forEach(batch, (waiting) =>
      asSent(waiting, server).pipe(
        Effect.map((json) => ({ uuid: waiting.uuid, json })),
        // An event its schema refuses never leaves; the rest of the batch does.
        Effect.tapError((cause) =>
          Effect.logWarning("A usage event did not encode", { event: waiting.event.event, cause }),
        ),
        Effect.option,
      ),
    ).pipe(Effect.map((each) => each.flatMap(Option.toArray)));
    if (encoded.length === 0) return;
    yield* HttpClientRequest.post(`${environment.host}/batch/`).pipe(
      HttpClientRequest.bodyJson({
        api_key: environment.key,
        batch: encoded.map((each) => each.json),
      }),
      Effect.flatMap(http.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      // Read to its end, so a body that stalls is the timeout's too and no socket outlives it.
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.timeout(timing.sendTimeout),
    );
    yield* store.keepSent(
      encoded.map(({ uuid, json }) => ({ uuid, body: JSON.stringify(json) })),
      yield* DateTime.now,
    );
  });

  const take = Ref.modify(
    buffer,
    (waiting) => [waiting.slice(0, BATCH_SIZE), waiting.slice(BATCH_SIZE)] as const,
  );

  /** Sends what waits, a batch at a time, until a batch fails or nothing waits. */
  const flush = Effect.gen(function* () {
    while (yield* sending) {
      const state = yield* Ref.get(delivery);
      const batch = state.failed.length > 0 ? state.failed : yield* take;
      if (batch.length === 0) return;
      const result = yield* Effect.result(send(batch));
      /** Sets what comes next, unless the switch went off meanwhile, which dropped the batch. */
      const settle = (next: Omit<Delivery, "epoch">) =>
        Ref.modify(delivery, (current) =>
          current.epoch === state.epoch
            ? ([true, { ...next, epoch: state.epoch }] as const)
            : ([false, current] as const),
        );
      if (result._tag === "Success") {
        if (yield* settle(idle(state.epoch))) continue;
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      const failures = state.failures + 1;
      const attempts = state.attempts + 1;
      const retryAt = now + retryDelay(timing, failures, yield* Random.next);
      const error = result.failure;
      const refused =
        error._tag === "HttpClientError" &&
        error.reason._tag === "StatusCodeError" &&
        REFUSED_BATCH_STATUSES.has(error.reason.response.status);
      if (!refused && attempts < MAX_BATCH_ATTEMPTS) {
        if (!(yield* settle({ failed: batch, attempts, failures, retryAt }))) return;
        yield* Effect.logDebug("Usage data could not be sent; it will be tried again", {
          attempts,
        });
        return;
      }
      // Waits even after dropping, so an endpoint that refuses everything is not asked in a loop.
      if (!(yield* settle({ failed: [], attempts: 0, failures, retryAt }))) return;
      yield* Effect.logWarning(
        refused
          ? "Usage data was refused, and dropped"
          : "Usage data could not be sent, and was dropped",
        { events: batch.length, attempts },
      );
      return;
    }
  }).pipe(lock.withPermits(1));

  const flushWhenDue = Effect.gen(function* () {
    const { retryAt } = yield* Ref.get(delivery);
    if ((yield* Clock.currentTimeMillis) >= retryAt) yield* flush;
  });

  /** What waits, and a failed batch, are dropped: off means nothing more leaves. */
  const drop = Effect.andThen(
    Ref.set(buffer, []),
    Ref.update(delivery, (current) => idle(current.epoch + 1)),
  );

  yield* onOff.changes.pipe(
    Stream.runForEach((enabled) => (enabled ? Effect.void : drop)),
    Effect.forkScoped,
  );
  yield* Effect.sleep(timing.interval).pipe(
    Effect.andThen(flushWhenDue),
    Effect.forever,
    Effect.forkScoped,
  );
  // The stop waits for this at most `shutdownFlush`: usage data never holds a stop or an update.
  yield* Effect.addFinalizer(() => flush.pipe(Effect.timeout(timing.shutdownFlush), Effect.ignore));

  const record = Effect.fn("Telemetry.record")(function* (
    event: TelemetryEvent,
    client?: TelemetryClient,
  ) {
    if (!(yield* sending)) return;
    const uuid = yield* random.uuidV7();
    const at = yield* DateTime.now;
    yield* Ref.update(buffer, (waiting) => {
      const next = [...waiting, { uuid, at, event, client }];
      return next.length > MAX_BUFFERED_EVENTS
        ? next.slice(next.length - MAX_BUFFERED_EVENTS)
        : next;
    });
  });

  const sent = store.sent.pipe(
    Effect.map((bodies) =>
      bodies
        .flatMap((body) => Option.toArray(decodeSent(body)))
        .slice(0, MAX_SENT_TELEMETRY_EVENTS),
    ),
  );

  return Telemetry.of({ record, sending, sent });
});

export const layer = (timing: DeliveryTiming = DEFAULT_TIMING) =>
  Layer.effect(Telemetry, make(timing)).pipe(Layer.provide(SecureRandom.layerWebCrypto));
