// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ORCHESTRATION_PROTOCOL, pin } from "./Pin.ts";

// Runs the engine as a child process and says, at every moment, whether it can
// take commands. Being down is a state, not a failure: the supervisor restarts
// the engine with backoff for as long as its scope lives.

export type ProcessState =
  | { readonly _tag: "starting" }
  | { readonly _tag: "ready"; readonly environmentId: string }
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "incompatible"; readonly runningVersion: string };

export interface SupervisorInput {
  readonly executable: string;
  /** The engine's `--base-dir`. */
  readonly home: string;
  readonly port: number;
  /** Runs before every start, while the engine is down: provisioning, credential renewal. */
  readonly beforeStart: Effect.Effect<void>;
}

const STARTUP_TIMEOUT = Duration.seconds(90);
const HEALTH_INTERVAL = Duration.seconds(5);
/** Consecutive failed health checks after which a running engine counts as hung. */
const HEALTH_FAILURES = 3;
/** A run this long resets the restart backoff. */
const STABLE_RUN = Duration.minutes(1);
const BACKOFF_MAX_MS = 30_000;

const decodeDescriptor = HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor);

export const baseUrl = (port: number) => `http://127.0.0.1:${port}`;

type Health =
  | { readonly _tag: "ready"; readonly environmentId: string }
  | { readonly _tag: "incompatible"; readonly runningVersion: string }
  | { readonly _tag: "down" };

/** What the engine on `port` answers at its environment descriptor. */
export const probe = Effect.fn("engine.probe")(function* (port: number) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(`${baseUrl(port)}/.well-known/t3/environment`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(decodeDescriptor),
    Effect.timeout(Duration.seconds(3)),
    Effect.map((descriptor): Health =>
      descriptor.serverVersion === pin.version &&
      descriptor.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL
        ? { _tag: "ready", environmentId: descriptor.environmentId }
        : { _tag: "incompatible", runningVersion: descriptor.serverVersion },
    ),
    Effect.orElseSucceed((): Health => ({ _tag: "down" })),
  );
});

/**
 * Starts the supervision loop in the current scope and returns the state it
 * publishes. Closing the scope stops the engine.
 */
export const supervise = Effect.fn("engine.supervise")(function* (input: SupervisorInput) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
  const state = yield* SubscriptionRef.make<ProcessState>({ _tag: "starting" });
  const check = probe(input.port).pipe(Effect.provideService(HttpClient.HttpClient, http));

  const command = ChildProcess.make(
    input.executable,
    [
      "serve",
      "--base-dir",
      input.home,
      "--port",
      String(input.port),
      "--host",
      "127.0.0.1",
      "--no-browser",
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: "10 seconds",
    },
  );

  /** One engine process, from spawn to exit. Returns whether to keep restarting. */
  const runOnce = Effect.scoped(
    Effect.gen(function* () {
      // Something else on the port would answer health checks for a process
      // that is not ours; wait until it is gone.
      if ((yield* check)._tag !== "down") {
        yield* Effect.logWarning(`Port ${input.port} is taken; the engine waits for it.`);
        return true;
      }
      yield* input.beforeStart;
      yield* SubscriptionRef.set(state, { _tag: "starting" });
      const handle = yield* spawner.spawn(command);
      const exited = yield* handle.exitCode.pipe(Effect.forkScoped);

      const healthy = check.pipe(
        Effect.repeat({
          schedule: Schedule.spaced(Duration.millis(250)),
          until: (health) => health._tag !== "down",
        }),
        Effect.timeoutOption(STARTUP_TIMEOUT),
      );
      const started = yield* Effect.raceFirst(
        healthy,
        Fiber.await(exited).pipe(Effect.as(Option.none<Health>())),
      );
      if (Option.isNone(started) || started.value._tag === "down") return true;
      if (started.value._tag === "incompatible") {
        yield* SubscriptionRef.set(state, started.value);
        return false;
      }
      yield* SubscriptionRef.set(state, started.value);

      // Healthy until it exits or stops answering.
      const hung = Effect.gen(function* () {
        let failures = 0;
        while (failures < HEALTH_FAILURES) {
          yield* Effect.sleep(HEALTH_INTERVAL);
          failures = (yield* check)._tag === "ready" ? 0 : failures + 1;
        }
      });
      yield* Effect.raceFirst(Fiber.await(exited).pipe(Effect.asVoid), hung);
      return true;
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("The engine stopped", cause).pipe(Effect.as(true)),
    ),
  );

  const loop = Effect.gen(function* () {
    let failures = 0;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      const keepGoing = yield* runOnce;
      if (!keepGoing) return;
      const current = yield* SubscriptionRef.get(state);
      if (current._tag !== "incompatible")
        yield* SubscriptionRef.set(state, { _tag: "unavailable" });
      const ranFor = (yield* Clock.currentTimeMillis) - startedAt;
      failures = ranFor >= Duration.toMillis(STABLE_RUN) ? 0 : failures + 1;
      yield* Effect.sleep(Duration.millis(Math.min(BACKOFF_MAX_MS, 500 * 2 ** failures)));
    }
  });

  yield* Effect.forkScoped(loop);
  return {
    current: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state).pipe(Stream.changesWith((a, b) => a._tag === b._tag)),
  };
});

export type Supervisor = Effect.Success<ReturnType<typeof supervise>>;
