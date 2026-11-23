// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Whether another program holds the engine's port takes a trial listen from node:net.
import * as NodeNet from "node:net";
import type { EngineInstallProgress, EngineStatus } from "@j3-bots/contracts";
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { boundedCommand, engineEnvironment } from "./Command.ts";
import type { Access } from "./Credential.ts";
import { ORCHESTRATION_PROTOCOL, pin } from "./Pin.ts";
import { engineFolders, harnessDefaultHomes, type PrivateFiles } from "./PrivateFiles.ts";

// Runs the engine as a child process and says, at every moment, whether it can
// take commands. Being down is a state, not a failure: the supervisor restarts
// the engine with backoff for as long as its scope lives.
//
// The engine is ready only when it answers as the pinned version and accepts
// J3 Bots' credential. An engine J3 Bots started and then lost track of (the
// server crashed and left it running) is found by the environment id recorded
// when it started, and stopped before a new one starts. Any other program on
// the port, whether or not it answers HTTP, is left alone: the engine waits
// for the port, as `port-in-use`, instead of being started to fail there.
//
// A restart asked for stops the engine and starts it again at once, with
// `beforeStart` run between, so what it provisions reaches every harness.

type UnavailableReason = Extract<EngineStatus["state"], { readonly _tag: "unavailable" }>["reason"];

export type ProcessState =
  /** `install` while the pinned engine downloads, before the supervisor runs. */
  | { readonly _tag: "starting"; readonly install?: EngineInstallProgress }
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
  /**
   * Runs before every start, while the engine is down: provisioning, the
   * credential. A failure keeps the engine down, and the start is tried again.
   */
  readonly beforeStart: Effect.Effect<void, E>;
  /** What the engine makes of J3 Bots' current credential. */
  readonly checkAccess: Effect.Effect<Access>;
  /** Mints a fresh credential, once the engine refused the current one. */
  readonly reissueCredential: Effect.Effect<void>;
  /** Where the record of the started process is written. */
  readonly files: PrivateFiles;
}

const STARTUP_TIMEOUT = Duration.seconds(90);
const HEALTH_INTERVAL = Duration.seconds(5);
/** Consecutive failed health checks after which a running engine counts as hung. */
const HEALTH_FAILURES = 3;
/** A run this long resets the restart backoff. */
const STABLE_RUN = Duration.minutes(1);
const BACKOFF_MAX_MS = 30_000;
/** How long the engine gets to stop on SIGTERM before SIGKILL, when the server stops. */
const ENGINE_STOP = "10 seconds";
/** How long a lost engine gets to stop on SIGTERM, and then on SIGKILL. */
const ORPHAN_TERM_GRACE = Duration.seconds(10);
const ORPHAN_KILL_GRACE = Duration.seconds(5);

const decodeDescriptor = HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor);

export const baseUrl = (port: number) => `http://127.0.0.1:${port}`;

/** Where the engine on `port` describes itself, without authentication (docs/architecture/engine.md). */
export const descriptorUrl = (port: number) => `${baseUrl(port)}/.well-known/t3/environment`;

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
  return yield* client.get(descriptorUrl(port)).pipe(
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

/**
 * Whether another program holds `port` on loopback, where the engine listens:
 * a trial listen there fails with `EADDRINUSE`. Any other failure (the port
 * may not be bound by this user, say) is the engine's to report when it starts.
 */
const portTaken = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const server = NodeNet.createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resume(Effect.succeed(error.code === "EADDRINUSE")),
    );
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resume(Effect.succeed(false)));
    });
    return Effect.sync(() => server.close());
  });

/** The engine process the supervisor last started, recorded under `<home>/j3/`. */
const EngineProcess = Schema.Struct({ pid: Schema.Int, environmentId: Schema.String });
const decodeEngineProcess = Schema.decodeUnknownOption(Schema.fromJsonString(EngineProcess));
const encodeEngineProcess = Schema.encodeEffect(Schema.fromJsonString(EngineProcess));

/** What the running supervision loop can be asked. */
export interface Supervision {
  /**
   * Stops the engine, if it runs, and starts it again at once, whatever the
   * restart backoff. Returns `true` once the engine it stopped is gone and
   * the state says so, before the new one starts; `false` at once when the
   * loop no longer runs, as after the engine was found incompatible, so
   * nothing will start the engine again.
   */
  readonly restart: Effect.Effect<boolean>;
}

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
  const recordFile = path.join(engineFolders(path, input.home).j3, "engine-process.json");
  // Each J3 Bots instance has a configuration folder of its own, which the
  // engine sets for it. Any other run of a harness the engine makes gets
  // these, empty and J3 Bots' own, instead of the server user's own
  // `~/.claude` and `~/.codex`: the engine's check of the installed Codex
  // (`codex --version`, **Read** at `59651c1`, `CodexInstallation.ts`), and a
  // harness a bot runs in its shell.
  const defaults = harnessDefaultHomes(path, input.home);
  const environment = {
    ...engineEnvironment(yield* Effect.sync(() => process.env)),
    CLAUDE_CONFIG_DIR: defaults.claudeCode,
    CODEX_HOME: defaults.codex,
  };

  const engine = boundedCommand(
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
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: environment, extendEnv: false },
    ENGINE_STOP,
  );

  /** Runs a short system command; its exit code, or -1 if it could not run. */
  const system = (executable: string, args: ReadonlyArray<string>) =>
    spawner.exitCode(boundedCommand(executable, args, { stdin: "ignore", stderr: "ignore" })).pipe(
      Effect.map(Number),
      Effect.orElseSucceed(() => -1),
    );

  const isAlive = (pid: number) =>
    system("ps", ["-p", String(pid), "-o", "pid="]).pipe(Effect.map((code) => code === 0));

  /** Whether `pid` is an engine serving this data directory, by its command line. */
  const servesHome = (pid: number) =>
    spawner.string(boundedCommand("ps", ["-p", String(pid), "-o", "args="])).pipe(
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
      Effect.flatMap((text) => input.files.write(recordFile, text)),
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
      // Another program holds the port, an engine of another home or anything
      // that is not an engine at all: never ours to stop.
      const taken =
        found._tag === "up"
          ? !(yield* stopLostEngine(found.environmentId))
          : yield* portTaken(input.port);
      if (taken) {
        yield* SubscriptionRef.set(state, { _tag: "unavailable", reason: "port-in-use" });
        yield* Effect.logWarning(`Port ${input.port} is taken; the engine waits for it.`);
        return true;
      }
      yield* input.beforeStart;
      yield* SubscriptionRef.set(state, { _tag: "starting" });
      const handle = yield* spawner.spawn(engine);
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

  /** Each restart asked for, completed once the engine it stopped is gone. */
  const restarts = yield* Queue.unbounded<Deferred.Deferred<void>>();

  /** Whatever ends first: `effect`, or a restart asked for, which interrupts it. */
  const untilRestart = <A, E2>(effect: Effect.Effect<A, E2>) =>
    Effect.raceFirst(
      effect.pipe(Effect.map((value) => ({ _tag: "done", value }) as const)),
      Queue.take(restarts).pipe(Effect.map((asked) => ({ _tag: "restart", asked }) as const)),
    );

  /** Answers a restart, and every other one asked for meanwhile. */
  const restarted = Effect.fnUntraced(function* (asked: Deferred.Deferred<void>) {
    for (const done of [asked, ...(yield* Queue.clear(restarts))]) {
      yield* Deferred.succeed(done, undefined);
    }
  });

  const loop = Effect.gen(function* () {
    let failures = 0;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      // Interrupting the run closes its scope, which stops the engine.
      const ran = yield* untilRestart(runOnce);
      if (ran._tag === "done" && !ran.value) return;
      const current = yield* SubscriptionRef.get(state);
      if (current._tag === "ready" || current._tag === "starting") {
        yield* SubscriptionRef.set(state, { _tag: "unavailable", reason: "down" });
      }
      if (ran._tag === "restart") {
        failures = 0;
        yield* restarted(ran.asked);
        continue;
      }
      const ranFor = (yield* Clock.currentTimeMillis) - startedAt;
      failures = ranFor >= Duration.toMillis(STABLE_RUN) ? 0 : failures + 1;
      const waited = yield* untilRestart(
        Effect.sleep(Duration.millis(Math.min(BACKOFF_MAX_MS, 500 * 2 ** failures))),
      );
      if (waited._tag === "restart") {
        failures = 0;
        yield* restarted(waited.asked);
      }
    }
  });

  /** Completed when the loop ends: no restart asked for is answered after that. */
  const ended = yield* Deferred.make<void>();
  yield* Effect.forkScoped(loop.pipe(Effect.ensuring(Deferred.succeed(ended, undefined))));

  return {
    restart: Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      yield* Queue.offer(restarts, done);
      return yield* Effect.raceFirst(
        Deferred.await(done).pipe(Effect.as(true)),
        Deferred.await(ended).pipe(Effect.as(false)),
      );
    }),
  } satisfies Supervision;
});

/** Whether two states say the same: same tag, reason and download progress. */
const sameState = (a: ProcessState, b: ProcessState): boolean => {
  switch (a._tag) {
    case "starting":
      return (
        b._tag === "starting" &&
        a.install?.receivedBytes === b.install?.receivedBytes &&
        a.install?.totalBytes === b.install?.totalBytes
      );
    case "unavailable":
      return b._tag === "unavailable" && a.reason === b.reason;
    case "ready":
    case "incompatible":
      return a._tag === b._tag;
  }
};

/** The state as a stream of changes, starting with the current one. */
export const stateChanges = (state: SubscriptionRef.SubscriptionRef<ProcessState>) =>
  SubscriptionRef.changes(state).pipe(Stream.changesWith(sameState));
