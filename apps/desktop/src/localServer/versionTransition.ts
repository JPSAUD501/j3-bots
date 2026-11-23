// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ServerUpdate } from "@j3-bots/desktop-bridge";
import * as Transition from "@j3-bots/server/transition";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Runtime from "./runtime.ts";
import {
  LaunchFailed,
  lastMessage,
  type RunningServer,
  type ServerExit,
  stopServer,
} from "./supervisor.ts";

// The version of the server on this computer, from one app release to the
// next: the desktop app as a host of the version transition core
// (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md). An
// app update brings a new server release in its package; the first start of
// it on the home snapshots the data, stops the release that ran, starts the
// new one, and rolls back to the one that ran, from the runtime kept in
// `<userData>/server-runtime/`, when the new one does not become ready.
//
// Each start asks the home's record what may start (`decideStart`):
//
// - `start`: the package's release, as it is, recorded once it answers;
// - `snapshot-then-start`: the transition, under the home's lock;
// - `refuse-rolled-back`: the release the data was rolled back to, and the
//   package's one again only when the person asks (`retry`);
// - `refuse-downgrade`: the newer release the data was handed to, from its
//   kept runtime, while the app is older;
// - `refuse-unknown-schema`: nothing, with why.
//
// A rollback left unfinished is finished first. A start runs inside the
// supervisor's uninterruptible launch, so quitting the app waits for a
// transition to end, its record and pruning included; a system that kills
// the app leaves the record's pending transition or the rollback's mark,
// which the next start carries on from.

/** The longest log tail and reason the page is given, as the bridge bounds them. */
const LOG_TAIL = 8192;
const REASON = 4096;

/** What a start does on the home, as its record decides it. */
type Plan =
  | { readonly _tag: "finish-rollback"; readonly snapshot: Transition.Snapshot }
  | {
      readonly _tag: "run";
      readonly version: string;
      readonly update: Option.Option<ServerUpdate>;
    }
  | { readonly _tag: "transition"; readonly from: string }
  | { readonly _tag: "refused"; readonly reason: string };

/** A server a step started, for one side of a transition, and its end once it came. */
interface Started {
  readonly side: Transition.Side;
  readonly server: RunningServer;
  readonly exit: Deferred.Deferred<ServerExit>;
}

export interface VersionTransitionOptions {
  /** The server's home. */
  readonly home: string;
  /** The runtime the package carries. */
  readonly source: string;
  /** Its release. */
  readonly bundled: Runtime.RuntimeRelease;
  /** `<userData>/server-runtime`. */
  readonly runtimes: string;
  readonly platform: NodeJS.Platform;
  /** Starts a server from `runtime`. */
  readonly run: (runtime: Runtime.Runtime) => Effect.Effect<RunningServer, LaunchFailed>;
}

/** Why a stopped server stopped, in a sentence, with the last thing it wrote. */
const exitReason = (exit: ServerExit, logTail: string) => {
  const how =
    exit.signal === null
      ? `it stopped with exit code ${exit.code ?? "unknown"}`
      : `it was stopped by ${exit.signal}`;
  const said = lastMessage(logTail);
  return said === undefined ? how : `${how}: ${said}`;
};

const isLaunchFailed = Schema.is(LaunchFailed);

const clip = (text: string, length: number) =>
  text.length > length ? text.slice(text.length - length) : text;

export const make = Effect.fn("VersionTransition.make")(function* (
  options: VersionTransitionOptions,
) {
  const { home, bundled, runtimes } = options;
  const path = yield* Path.Path;
  const update = yield* SubscriptionRef.make(Option.none<ServerUpdate>());
  /** Set by `retry`, taken by the next start. */
  const retryAsked = yield* Ref.make(false);
  /** What to do once the server a start gave answers: record it, for a release started as it is. */
  const afterReady = yield* Ref.make<Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>>(
    Effect.void,
  );

  const notReady = (error: Runtime.RuntimeNotReady) =>
    new LaunchFailed({ reason: error.message, retry: error.reason === "not-copied" });
  const unreadable = (error: { readonly message: string }) =>
    new LaunchFailed({
      reason: clip(`The bots' data on this computer could not be read: ${error.message}`, REASON),
      retry: false,
    });
  /** A failure of the home's own files, unless the start failed for a reason of its own. */
  const onTheHome = (error: { readonly message: string }) =>
    isLaunchFailed(error) ? error : unreadable(error);

  /** What a start does now; `retrying` when the person asked to try the package's release again. */
  const decide = Effect.fn("VersionTransition.decide")(function* (retrying: boolean) {
    const unfinished = yield* Transition.unfinishedRollback(home);
    if (Option.isSome(unfinished)) {
      return { _tag: "finish-rollback", snapshot: unfinished.value.snapshot } satisfies Plan;
    }
    const recorded = yield* Transition.readRuntimeRecord(home);
    const decision = Transition.decideStart({
      recorded,
      starting: bundled.version,
      kept: yield* Runtime.kept(runtimes),
      rollingBackTo: Option.none(),
    });
    if (decision === "start") {
      return { _tag: "run", version: bundled.version, update: Option.none() } satisfies Plan;
    }
    if (recorded._tag !== "recorded") {
      // Only a record this release reads decides anything but a plain start.
      return {
        _tag: "refused",
        reason:
          "The bots' data on this computer keeps a record of the J3 Bots release it was last used with (state/runtime.json) that this one cannot read: a newer J3 Bots wrote it, or it is damaged. Install the newer J3 Bots again.",
      } satisfies Plan;
    }
    const { version, pending } = recorded.record;
    switch (decision) {
      case "snapshot-then-start":
        return { _tag: "transition", from: version } satisfies Plan;
      case "refuse-rolled-back": {
        if (retrying) return { _tag: "transition", from: version } satisfies Plan;
        const known = yield* SubscriptionRef.get(update);
        // What this run of the app saw of the failure stays with the notice.
        const seen = Option.filter(
          known,
          (notice) =>
            notice._tag === "rolled-back" &&
            notice.running === version &&
            notice.failed === bundled.version,
        );
        return {
          _tag: "run",
          version,
          update: Option.orElse(seen, () =>
            Option.some<ServerUpdate>({
              _tag: "rolled-back",
              running: version,
              failed: bundled.version,
            }),
          ),
        } satisfies Plan;
      }
      case "refuse-downgrade":
        return {
          _tag: "run",
          version,
          update: Option.some<ServerUpdate>({
            _tag: "older-app",
            running: version,
            app: bundled.version,
          }),
        } satisfies Plan;
      case "refuse-unknown-schema":
        return {
          _tag: "refused",
          reason:
            pending === undefined
              ? `The bots' data on this computer was last used by J3 Bots ${version}, and this one (${bundled.version}) cannot tell that it reads that data. Install J3 Bots ${version} or newer.`
              : `An update of the bots' data on this computer, from J3 Bots ${pending.from.version} to ${pending.to.version}, was cut off, and this one (${bundled.version}) cannot carry it on. Install J3 Bots ${pending.to.version} or newer.`,
        } satisfies Plan;
    }
  });

  /** Runs the release `version` keeps a runtime of, as it is. */
  const runKept = (version: string) =>
    Runtime.ready({ folder: runtimes, version, platform: options.platform }).pipe(
      Effect.mapError(notReady),
      Effect.flatMap(options.run),
    );

  /**
   * Runs `operation` on the home with the desktop's steps, under its lock,
   * then answers the server it left running, if one, and why the new release
   * failed when it did.
   */
  const withSteps = Effect.fn("VersionTransition.withSteps")(function* <A, E>(
    operation: (
      lock: Transition.TransitionLock,
      steps: Transition.HostStepsFor<FileSystem.FileSystem | Path.Path>,
    ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ) {
    const started = yield* Ref.make(Option.none<Started>());
    /** The log tail of the new release's server, kept as it was stopped. */
    const failedTail = yield* Ref.make(Option.none<string>());

    const stopStarted = Effect.gen(function* () {
      const now = yield* Ref.getAndSet(started, Option.none());
      if (Option.isNone(now)) return;
      yield* stopServer(now.value.server);
      // Read once it stopped: the next server's output follows it in the same log.
      if (now.value.side === "new") {
        yield* Ref.set(failedTail, Option.some(yield* now.value.server.logTail));
      }
    });

    const steps: Transition.HostStepsFor<FileSystem.FileSystem | Path.Path> = (releases) => ({
      supervised: true,
      stop: stopStarted,
      disable: stopStarted,
      start: (side) =>
        Effect.gen(function* () {
          const server = yield* runKept(releases[side].version);
          const exit = yield* Deferred.make<ServerExit>();
          yield* server.exited.pipe(
            Effect.flatMap((ended) => Deferred.succeed(exit, ended)),
            Effect.forkDetach,
          );
          yield* Ref.set(started, Option.some({ side, server, exit }));
        }).pipe(
          Effect.mapError(
            (failure) =>
              new Transition.StepFailed({
                step: side === "new" ? "start-new" : "start-old",
                reason: failure.reason,
              }),
          ),
        ),
      probe: Effect.fn("VersionTransition.probe")(function* (side: Transition.Side) {
        const now = yield* Ref.get(started);
        if (Option.isNone(now) || now.value.side !== side) {
          return { _tag: "exited", reason: "it is not running" } as const;
        }
        const { server, exit } = now.value;
        if (yield* Deferred.isDone(exit)) {
          const ended = yield* Deferred.await(exit);
          return { _tag: "exited", reason: exitReason(ended, yield* server.logTail) } as const;
        }
        return {
          _tag: "running",
          pid: Option.some(server.pid),
          answer: yield* server.admin.status(Duration.seconds(5)).pipe(Effect.option),
        } as const;
      }),
      // The desktop runs whichever release it started: nothing to point elsewhere.
      adopt: () => Effect.void,
      pruneRuntimes: (keep) => Runtime.prune(runtimes, keep),
    });

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const lock = yield* Transition.TransitionLock.hold(
          home,
          () =>
            new LaunchFailed({
              reason: "Another change to the bots' data on this computer is under way.",
              retry: true,
            }),
        );
        return yield* operation(lock, steps);
      }),
    );
    return {
      result,
      running: Option.map(yield* Ref.get(started), (now) => now.server),
      failedTail: yield* Ref.get(failedTail),
      stopStarted,
    };
  });

  /** Ends a start whose rollback failed: whatever it left running is stopped. */
  const rollbackFailed = (
    stopStarted: Effect.Effect<void>,
    failed: Option.Option<Transition.StepFailed>,
    rollback: Transition.StepFailed,
  ) =>
    Effect.andThen(
      stopStarted,
      Effect.fail(
        new LaunchFailed({
          reason: clip(
            Option.match(failed, {
              onNone: () =>
                `Bringing back the bots' data as it was before an update failed: ${rollback.reason}`,
              onSome: (cause) =>
                `The update failed (${cause.reason}), and so did bringing back the bots' data as it was before it: ${rollback.reason}`,
            }),
            REASON,
          ),
          fix: "Try again: J3 Bots carries on from where it stopped.",
          retry: false,
        }),
      ),
    );

  /** A rollback that stopped after the release it ends on answered still leaves it running. */
  const runsAfter = (rollback: Transition.StepFailed) =>
    rollback.step === "record" || rollback.step === "unmark";

  const finishRollback = Effect.fn("VersionTransition.finishRollback")(function* (
    snapshot: Transition.Snapshot,
  ) {
    yield* Effect.logInfo("Finishing a rollback of the bots' data a stop cut short", {
      snapshot: snapshot.folder,
    });
    const done = yield* withSteps((lock, steps) => Transition.rollBack({ lock, snapshot, steps }));
    const running = Option.filter(done.running, () =>
      Option.match(done.result, { onNone: () => true, onSome: runsAfter }),
    );
    if (Option.isSome(done.result)) {
      yield* Effect.logWarning("Finishing the rollback failed", done.result.value);
      if (Option.isNone(running)) {
        return yield* rollbackFailed(done.stopStarted, Option.none(), done.result.value);
      }
    }
    if (Option.isNone(running)) {
      return yield* new LaunchFailed({ reason: "The server did not start.", retry: true });
    }
    const failed = snapshot.manifest.to.version;
    yield* SubscriptionRef.set(
      update,
      failed === bundled.version
        ? Option.some<ServerUpdate>({
            _tag: "rolled-back",
            running: snapshot.manifest.from.version,
            failed,
          })
        : Option.none(),
    );
    return running.value;
  });

  const runTransition = Effect.fn("VersionTransition.runTransition")(function* (from: string) {
    const engine = yield* Runtime.releaseOf(path.join(runtimes, from)).pipe(
      Effect.map((release) => Option.fromUndefinedOr(release.engine)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const old: Transition.SnapshotRelease = Option.match(engine, {
      onNone: () => ({ version: from }),
      onSome: (pinned) => ({ version: from, engine: pinned }),
    });
    yield* SubscriptionRef.set(
      update,
      Option.some<ServerUpdate>({ _tag: "updating", from, to: bundled.version }),
    );
    yield* Effect.logInfo("Moving the bots' data to this app's server", {
      from,
      to: bundled.version,
    });
    const done = yield* withSteps((lock, steps) =>
      Transition.transition({ lock, from: old, to: bundled, steps }),
    );
    const { result } = done;
    if (Option.isSome(result.interrupted)) {
      yield* Effect.logInfo("Rolled back an update a stop had cut off first", {
        to: result.interrupted.value.version,
      });
    }
    if (Option.isSome(result.recording)) {
      yield* Effect.logWarning("The new server runs, but recording it failed", result.recording);
    }
    if (Option.isSome(result.pruning)) {
      yield* Effect.logWarning("Removing older servers and snapshots failed", result.pruning);
    }
    const { outcome } = result;
    switch (outcome._tag) {
      case "updated":
      case "cut-off-rolled-back":
        // Once it answers, as the page sees it: until then the line still says it updates.
        yield* Ref.set(afterReady, SubscriptionRef.set(update, Option.none()));
        break;
      case "rolled-back":
        yield* Effect.logWarning("The new server did not start; the one before runs again", {
          failed: outcome.failed,
        });
        yield* SubscriptionRef.set(
          update,
          Option.some<ServerUpdate>({
            _tag: "rolled-back",
            running: result.from.version,
            failed: bundled.version,
            reason: clip(outcome.failed.reason, REASON),
            ...Option.match(done.failedTail, {
              onNone: () => ({}),
              onSome: (tail) => ({ logTail: clip(tail, LOG_TAIL) }),
            }),
          }),
        );
        break;
      case "rollback-failed":
      case "cut-off-rollback-failed": {
        const failed =
          outcome._tag === "rollback-failed" ? Option.some(outcome.failed) : Option.none();
        yield* SubscriptionRef.set(update, Option.none());
        if (!runsAfter(outcome.rollback) || Option.isNone(done.running)) {
          return yield* rollbackFailed(done.stopStarted, failed, outcome.rollback);
        }
        yield* Effect.logWarning(
          "The server before the update runs, but the rollback did not finish",
          {
            rollback: outcome.rollback,
          },
        );
        break;
      }
    }
    if (Option.isNone(done.running)) {
      return yield* new LaunchFailed({ reason: "The server did not start.", retry: true });
    }
    return done.running.value;
  });

  const recordReady = (version: string) =>
    Transition.recordReady(home, version).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Recording the server that runs failed", { version, cause }),
      ),
    );

  /**
   * Starts the server the home's record lets start: what the supervisor's
   * launch runs, after the home's checks.
   */
  const launch = Effect.gen(function* () {
    const retrying = yield* Ref.getAndSet(retryAsked, false);
    yield* Ref.set(afterReady, Effect.void);
    const installed = yield* Runtime.install({ source: options.source, folder: runtimes }).pipe(
      Effect.mapError(notReady),
    );
    if (installed.version !== bundled.version) {
      return yield* new LaunchFailed({
        reason: `The server that comes with J3 Bots changed while it ran (${bundled.version}, now ${installed.version}). Quit J3 Bots and open it again.`,
        retry: false,
      });
    }
    const plan = yield* decide(retrying).pipe(Effect.mapError(unreadable));
    switch (plan._tag) {
      case "refused":
        yield* SubscriptionRef.set(update, Option.none());
        return yield* new LaunchFailed({ reason: plan.reason, retry: false });
      case "run": {
        const server = yield* runKept(plan.version);
        yield* SubscriptionRef.set(update, plan.update);
        yield* Ref.set(afterReady, recordReady(plan.version));
        return server;
      }
      case "transition":
        return yield* runTransition(plan.from).pipe(Effect.mapError(onTheHome));
      case "finish-rollback":
        return yield* finishRollback(plan.snapshot).pipe(Effect.mapError(onTheHome));
    }
  }).pipe(
    // A start that fails or stops moves nothing: an update said to be under way is not.
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : SubscriptionRef.update(
            update,
            Option.filter((notice) => notice._tag !== "updating"),
          ),
    ),
  );

  /**
   * Takes over a server an earlier run of the app left on the home with
   * `takeOver`, when it is the release a start would run as it is; any other
   * one `takeOver` stops, as it does with no release given.
   */
  const adopt = Effect.fn("VersionTransition.adopt")(function* (
    takeOver: (version: Option.Option<string>) => Effect.Effect<Option.Option<RunningServer>>,
  ) {
    const plan = yield* decide(false).pipe(Effect.option);
    const run = Option.flatMap(plan, (now) =>
      now._tag === "run" ? Option.some(now) : Option.none(),
    );
    const taken = yield* takeOver(Option.map(run, (now) => now.version));
    if (Option.isSome(taken) && Option.isSome(run)) {
      yield* SubscriptionRef.set(update, run.value.update);
      yield* Ref.set(afterReady, recordReady(run.value.version));
    }
    return taken;
  });

  return {
    launch,
    adopt,
    /** Once the server a start gave answers: records it, when it was started as it is. */
    onReady: Effect.flatten(Ref.getAndSet(afterReady, Effect.void)),
    /** What the server's version is going through, if anything. */
    update: SubscriptionRef.get(update),
    updates: SubscriptionRef.changes(update) satisfies Stream.Stream<Option.Option<ServerUpdate>>,
    /**
     * Has the next start try the app's release again, when the server was
     * rolled back from it, and says the update is under way from now on, as
     * the server that runs stops for it. Whether it was rolled back.
     */
    retry: Effect.gen(function* () {
      const now = yield* SubscriptionRef.get(update);
      if (Option.isNone(now) || now.value._tag !== "rolled-back") return false;
      yield* Ref.set(retryAsked, true);
      yield* SubscriptionRef.set(
        update,
        Option.some({ _tag: "updating", from: now.value.running, to: bundled.version }),
      );
      return true;
    }),
  };
});
