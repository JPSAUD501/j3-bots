// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus } from "@j3-bots/contracts";
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { Access } from "./Credential.ts";
import { ORCHESTRATION_PROTOCOL, pin } from "./Pin.ts";

// Runs the engine as a child process and says, at every moment, whether it can
// take commands. Being down is a state, not a failure: the supervisor restarts
// the engine with backoff for as long as its scope lives.
//
// The engine is ready only when it answers as the pinned version and accepts
// J3 Bots' credential. An engine J3 Bots started and then lost track of (the
// server crashed and left it running) is found by the environment id recorded
// when it started, and stopped before a new one starts. Any other program on
// the port is left alone.

type UnavailableReason = Extract<EngineStatus["state"], { readonly _tag: "unavailable" }>["reason"];

export type ProcessState =
  | { readonly _tag: "starting" }
  | { readonly _tag: "ready"; readonly environmentId: string }
  | { readonly _tag: "unavailable"; readonly reason: UnavailableReason }
  | { readonly _tag: "incompatible"; readonly runningVersion: string };

export interface SupervisorInput<E> {
  readonly executable: string;
  /** The engine's `--base-dir`. */
  readonly home: string;
  readonly port: number;
  /** Where the supervisor publishes the engine's state. */
  readonly state: SubscriptionRef.SubscriptionRef<ProcessState>;
  /** Runs before every start, while the engine is down: provisioning, the credential. */
  readonly beforeStart: Effect.Effect<void, E>;
  /** What the engine makes of J3 Bots' current credential. */
  readonly checkAccess: Effect.Effect<Access>;
  /** Mints a fresh credential, once the engine refused the current one. */
  readonly reissueCredential: Effect.Effect<void>;
}

const STARTUP_TIMEOUT = Duration.seconds(90);
const HEALTH_INTERVAL = Duration.seconds(5);
/** Consecutive failed health checks after which a running engine counts as hung. */
const HEALTH_FAILURES = 3;
/** A run this long resets the restart backoff. */
const STABLE_RUN = Duration.minutes(1);
const BACKOFF_MAX_MS = 30_000;
/** How long a lost engine gets to stop on SIGTERM, and then on SIGKILL. */
const ORPHAN_TERM_GRACE = Duration.seconds(10);
const ORPHAN_KILL_GRACE = Duration.seconds(5);

const decodeDescriptor = HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor);

export const baseUrl = (port: number) => `http://127.0.0.1:${port}`;

/** What answers on the port. */
type Probe =
  | { readonly _tag: "down" }
  | {
      readonly _tag: "up";
      readonly environmentId: string;
      readonly runningVersion: string;
      readonly compatible: boolean;
    };

/** What the engine on `port` answers at its environment descriptor. */
const probe = Effect.fn("engine.probe")(function* (port: number) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(`${baseUrl(port)}/.well-known/t3/environment`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(decodeDescriptor),
    Effect.timeout(Duration.seconds(3)),
    Effect.map((descriptor): Probe => ({
      _tag: "up",
      environmentId: descriptor.environmentId,
      runningVersion: descriptor.serverVersion,
      compatible:
        descriptor.serverVersion === pin.version &&
        descriptor.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL,
    })),
    Effect.orElseSucceed((): Probe => ({ _tag: "down" })),
  );
});

/** The engine process the supervisor last started, recorded under `<home>/j3/`. */
const EngineProcess = Schema.Struct({ pid: Schema.Int, environmentId: Schema.String });
const decodeEngineProcess = Schema.decodeUnknownOption(Schema.fromJsonString(EngineProcess));
const encodeEngineProcess = Schema.encodeEffect(Schema.fromJsonString(EngineProcess));

/**
 * Starts the supervision loop in the current scope. Closing the scope stops
 * the engine.
 */
export const supervise = Effect.fn("engine.supervise")(function* <E>(input: SupervisorInput<E>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { state } = input;
  const check = probe(input.port).pipe(Effect.provideService(HttpClient.HttpClient, http));
  const recordFile = path.join(input.home, "j3", "engine-process.json");

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

  /** Runs a short system command; its exit code, or -1 if it could not run. */
  const system = (executable: string, args: ReadonlyArray<string>) =>
    spawner
      .exitCode(ChildProcess.make(executable, [...args], { stdin: "ignore", stderr: "ignore" }))
      .pipe(
        Effect.map(Number),
        Effect.orElseSucceed(() => -1),
      );

  const isAlive = (pid: number) =>
    system("ps", ["-p", String(pid), "-o", "pid="]).pipe(Effect.map((code) => code === 0));

  /** Whether `pid` is an engine serving this data directory, by its command line. */
  const servesHome = (pid: number) =>
    spawner.string(ChildProcess.make("ps", ["-p", String(pid), "-o", "args="])).pipe(
      Effect.map((args) => {
        const words = args.trim().split(/\s+/);
        return words.includes("serve") && args.includes(` ${input.home} `);
      }),
      Effect.orElseSucceed(() => false),
    );

  const waitUntilGone = (pid: number, grace: Duration.Duration) =>
    isAlive(pid).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(Duration.millis(250)),
        until: (alive) => !alive,
      }),
      Effect.timeoutOption(grace),
      Effect.map(Option.isSome),
    );

  const recorded = fs.readFileString(recordFile).pipe(
    Effect.map(decodeEngineProcess),
    Effect.orElseSucceed(() => Option.none()),
  );

  const record = (pid: number, environmentId: string) =>
    encodeEngineProcess({ pid, environmentId }).pipe(
      Effect.flatMap((text) => fs.writeFileString(recordFile, text, { mode: 0o600 })),
      Effect.catch((error) => Effect.logWarning("Recording the engine process failed", error)),
    );

  /**
   * Stops an engine this data directory's supervisor started and lost: the
   * port answers with the environment id recorded at its start, and the
   * recorded process still serves this data directory. SIGTERM, then SIGKILL
   * after a grace period. Returns whether the port is free afterwards; any
   * other program on the port is never signalled.
   */
  const stopLostEngine = Effect.fnUntraced(function* (environmentId: string) {
    const lost = yield* recorded;
    if (Option.isNone(lost) || lost.value.environmentId !== environmentId) return false;
    const { pid } = lost.value;
    if (!(yield* servesHome(pid))) return false;
    yield* Effect.logWarning(
      `Stopping the engine a previous J3 Bots process left running (${pid}).`,
    );
    yield* system("kill", ["-TERM", String(pid)]);
    if (!(yield* waitUntilGone(pid, ORPHAN_TERM_GRACE))) {
      yield* system("kill", ["-KILL", String(pid)]);
      yield* waitUntilGone(pid, ORPHAN_KILL_GRACE);
    }
    return yield* check.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(Duration.millis(250)),
        until: (found) => found._tag === "down",
      }),
      Effect.timeoutOption(ORPHAN_KILL_GRACE),
      Effect.map(Option.isSome),
    );
  });

  /**
   * Whether the engine accepts the credential. A definitive refusal gets one
   * fresh credential per refusal; the next refusal stands until access is
   * granted again.
   */
  let reissued = false;
  const access = Effect.gen(function* () {
    const first = yield* input.checkAccess;
    if (first === "granted") reissued = false;
    if (first !== "refused" || reissued) return first;
    reissued = true;
    yield* input.reissueCredential;
    const second = yield* input.checkAccess;
    if (second === "granted") reissued = false;
    return second;
  });

  /** Publishes the state the engine's answers mean. Returns whether they count as healthy. */
  const settle = Effect.fnUntraced(function* (environmentId: string) {
    const granted = yield* access;
    if (granted === "unreachable") return false;
    yield* SubscriptionRef.set(
      state,
      granted === "granted"
        ? { _tag: "ready", environmentId }
        : { _tag: "unavailable", reason: "credential-refused" },
    );
    return true;
  });

  /** One engine process, from spawn to exit. Returns whether to keep restarting. */
  const runOnce = Effect.scoped(
    Effect.gen(function* () {
      const found = yield* check;
      if (found._tag === "up" && !(yield* stopLostEngine(found.environmentId))) {
        // Another program holds the port: never ours to stop.
        yield* SubscriptionRef.set(state, { _tag: "unavailable", reason: "port-in-use" });
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
          until: (health) => health._tag === "up",
        }),
        Effect.timeoutOption(STARTUP_TIMEOUT),
      );
      const started = yield* Effect.raceFirst(
        healthy,
        Fiber.await(exited).pipe(Effect.as(Option.none<Probe>())),
      );
      if (Option.isNone(started) || started.value._tag === "down") return true;
      const up = started.value;
      if (!up.compatible) {
        yield* SubscriptionRef.set(state, {
          _tag: "incompatible",
          runningVersion: up.runningVersion,
        });
        return false;
      }
      yield* record(Number(handle.pid), up.environmentId);
      if (!(yield* settle(up.environmentId))) return true;

      // Healthy until it exits or stops answering.
      const hung = Effect.gen(function* () {
        let failures = 0;
        while (failures < HEALTH_FAILURES) {
          yield* Effect.sleep(HEALTH_INTERVAL);
          const health = yield* check;
          const answered = health._tag === "up" && (yield* settle(health.environmentId));
          failures = answered ? 0 : failures + 1;
        }
      });
      yield* Effect.raceFirst(Fiber.await(exited).pipe(Effect.asVoid), hung);
      return true;
    }),
  ).pipe(
    // A failed run is restarted; an interrupt is the scope closing, and ends the loop.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) => Effect.logWarning("The engine stopped", cause).pipe(Effect.as(true)),
    ),
  );

  const loop = Effect.gen(function* () {
    let failures = 0;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      const keepGoing = yield* runOnce;
      if (!keepGoing) return;
      const current = yield* SubscriptionRef.get(state);
      if (current._tag === "ready" || current._tag === "starting") {
        yield* SubscriptionRef.set(state, { _tag: "unavailable", reason: "down" });
      }
      const ranFor = (yield* Clock.currentTimeMillis) - startedAt;
      failures = ranFor >= Duration.toMillis(STABLE_RUN) ? 0 : failures + 1;
      yield* Effect.sleep(Duration.millis(Math.min(BACKOFF_MAX_MS, 500 * 2 ** failures)));
    }
  });

  yield* Effect.forkScoped(loop);
});

/** The state as a stream of changes, starting with the current one. */
export const stateChanges = (state: SubscriptionRef.SubscriptionRef<ProcessState>) =>
  SubscriptionRef.changes(state).pipe(
    Stream.changesWith(
      (a, b) =>
        a._tag === b._tag &&
        (a._tag !== "unavailable" || (b._tag === "unavailable" && a.reason === b.reason)),
    ),
  );
