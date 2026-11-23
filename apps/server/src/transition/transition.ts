// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { HOME_ENTRIES } from "../home/entries.ts";
import { holdHome, holdLock } from "../home/Home.ts";
import {
  markRestoring,
  pruneSnapshots,
  restoreSnapshot,
  type Snapshot,
  type SnapshotRelease,
  takeSnapshot,
  unmarkRestoring,
  UPDATE_LOCK,
} from "../install/snapshot.ts";
import { isWithin, realLocation } from "../paths.ts";
import { awaitReady, type ServerProbe } from "./readiness.ts";
import { writeRuntimeRecord } from "./record.ts";
import {
  rollBackOver,
  type Side,
  StepFailed,
  switchOver,
  type SwitchOutcome,
  type SwitchSteps,
} from "./switch.ts";

// The version transition of a home, whoever hosts its server
// (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md): the
// switch of `switch.ts` with the steps on the home given, so a host gives
// only what it alone knows, how to stop, start, watch and adopt a release,
// and where it keeps their runtimes. `j3-bots update` gives the systemd
// service's steps; the desktop app gives its child process's.
//
//   stop → snapshot (under server.lock) → start V → ready → adopt → record V → prune
//
// If V never becomes ready: restore the snapshot → start U → ready → record U,
// rolled back from V. Two releases, two snapshots and two engine runtimes are
// kept.

/** How many releases, snapshots and engine runtimes a transition keeps. */
const KEEP = 2;

/**
 * Proof that this process holds a home's `<home>/backups/update.lock` for its
 * scope: one transition or rollback of the home at a time, the CLI's and the
 * desktop app's alike. Every transition takes one.
 */
export class TransitionLock {
  readonly home: string;

  private constructor(home: string) {
    this.home = home;
  }

  /** Holds the lock of `home` for the scope, or fails with `busy()` at once while another holds it. */
  static readonly hold = Effect.fn("TransitionLock.hold")(function* <E>(
    home: string,
    busy: () => E,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const backups = path.join(home, HOME_ENTRIES.backups);
    yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 });
    yield* holdLock(path.join(backups, UPDATE_LOCK), busy);
    return new TransitionLock(home);
  });
}

/** What a host gives a transition: how its server is stopped, started, watched and adopted. */
export interface HostSteps<R> {
  /** Whether the host runs a server on the home. Without one, nothing is stopped, started or recorded. */
  readonly supervised: boolean;
  /** Stops the server, and clears its failed state. It stays enabled. */
  readonly stop: Effect.Effect<void, StepFailed, R>;
  /** Stops the server, clears its failed state, and disables it: nothing starts it until a `start`. */
  readonly disable: Effect.Effect<void, StepFailed, R>;
  /** Starts that release's server, from its own runtime, and enables it. */
  readonly start: (side: Side) => Effect.Effect<void, StepFailed, R>;
  /** What the host sees of the server it started for that release, now. */
  readonly probe: (side: Side) => Effect.Effect<ServerProbe, never, R>;
  /** Makes that release the one the host runs from now on, once its server is ready. */
  readonly adopt: (side: Side) => Effect.Effect<void, StepFailed, R>;
  /** Removes the host's runtimes of every release but `keep`, the two a transition moved between. */
  readonly pruneRuntimes: (
    keep: readonly [string, string],
  ) => Effect.Effect<void, PlatformError.PlatformError, R>;
}

/** What the steps on the home run with. */
type HomeServices = FileSystem.FileSystem | Path.Path;

/** Runs `effect` holding the home's `server.lock`, failing as `step` while a server holds it. */
const withHome = <A, R>(
  home: string,
  step: StepFailed["step"],
  effect: Effect.Effect<A, { readonly _tag: string; readonly message: string }, R>,
) =>
  Effect.scoped(Effect.andThen(holdHome(home), effect)).pipe(
    Effect.mapError(
      (cause) =>
        new StepFailed({
          step,
          reason:
            cause._tag === "ServerAlreadyRunning"
              ? `A J3 Bots server its host did not start is running for ${home}. Stop it, then try again`
              : cause.message,
        }),
    ),
  );

/** The switch's steps: the host's, and the snapshot's on the home, for the two releases. */
const switchSteps = <R>(
  home: string,
  releases: Record<Side, SnapshotRelease>,
  host: HostSteps<R>,
): SwitchSteps<Snapshot, R | HomeServices> => ({
  supervised: host.supervised,
  stop: host.stop,
  disable: host.disable,
  start: host.start,
  adopt: host.adopt,
  ready: (side) =>
    awaitReady(
      releases[side].version,
      host.probe(side),
      side === "new" ? "await-new" : "await-old",
    ),
  snapshot: withHome(
    home,
    "snapshot",
    takeSnapshot({ home, from: releases.old, to: releases.new }),
  ),
  mark: (snapshot) =>
    markRestoring(snapshot).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "mark", reason: cause.message })),
    ),
  restore: (snapshot) => withHome(home, "restore", restoreSnapshot(home, snapshot)),
  unmark: (snapshot) =>
    unmarkRestoring(snapshot).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "unmark", reason: cause.message })),
    ),
});

/** Records that `version`'s server became ready, by a rollback from `rollbackFrom` if one: why it failed, if it did. */
const record = (home: string, version: string, rollbackFrom: Option.Option<string>) =>
  writeRuntimeRecord(home, version, rollbackFrom).pipe(
    Effect.as(Option.none<string>()),
    Effect.catch((cause) => Effect.succeedSome(cause.message)),
  );

/** Keeps the `KEEP` runtimes, snapshots and engine runtimes a transition leaves. */
const prune = Effect.fn("transition.prune")(function* <R>(
  home: string,
  from: SnapshotRelease,
  to: SnapshotRelease,
  host: HostSteps<R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* host.pruneRuntimes([from.version, to.version]);
  yield* pruneSnapshots(home, KEEP);
  if (from.engine !== undefined && to.engine !== undefined) {
    const realHome = Option.getOrElse(yield* realLocation(home), () => home);
    yield* EngineLive.pruneRuntimes({
      home: path.join(home, HOME_ENTRIES.engine),
      keep: [from.engine, to.engine],
      isPrivate: (location) =>
        realLocation(location).pipe(
          Effect.map((real) => Option.isSome(real) && isWithin(realHome, real.value)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
    });
  }
});

export interface TransitionResult {
  readonly outcome: SwitchOutcome<Snapshot>;
  /** Why the home's record could not be written, once a server became ready: the next start transitions again. */
  readonly recording: Option.Option<string>;
  /** Why keeping two of everything failed, which leaves only more on disk. */
  readonly pruning: Option.Option<string>;
}

/**
 * Moves the home `lock` holds from release `from` to `to`, with the host's
 * `steps`, to its end: never interrupted, it always leaves one release in
 * place. The release whose server it saw become ready is recorded, `to`, or
 * `from` rolled back from `to`. Only once `to` runs is anything pruned.
 */
export const transition = Effect.fn("transition.transition")(function* <R>(options: {
  readonly lock: TransitionLock;
  readonly from: SnapshotRelease;
  readonly to: SnapshotRelease;
  readonly steps: HostSteps<R>;
}) {
  const { lock, from, to, steps } = options;
  const { home } = lock;
  const outcome = yield* switchOver(switchSteps(home, { old: from, new: to }, steps));
  const recording = !steps.supervised
    ? Option.none<string>()
    : outcome._tag === "updated"
      ? yield* record(home, to.version, Option.none())
      : outcome._tag === "rolled-back"
        ? yield* record(home, from.version, Option.some(to.version))
        : Option.none<string>();
  const pruning =
    outcome._tag === "updated"
      ? yield* prune(home, from, to, steps).pipe(
          Effect.as(Option.none<string>()),
          Effect.catch((cause) => Effect.succeedSome(cause.message)),
        )
      : Option.none<string>();
  return { outcome, recording, pruning } satisfies TransitionResult;
});

export interface RollbackResult {
  /** The step that failed, if one did: the rollback stopped there. */
  readonly failed: Option.Option<StepFailed>;
  /** Why the home's record could not be written, once the old release's server became ready. */
  readonly recording: Option.Option<string>;
}

/**
 * Puts `snapshot` back on the home `lock` holds and starts the release it was
 * taken from, as one marked state, then adopts it: the rollback an operator
 * asks for, which also finishes one that was cut off, from where it got.
 * Once that release's server is ready, it is recorded, rolled back from the
 * release the snapshot was taken for.
 */
export const rollBack = Effect.fn("transition.rollBack")(function* <R>(options: {
  readonly lock: TransitionLock;
  readonly snapshot: Snapshot;
  readonly steps: HostSteps<R>;
}) {
  const { lock, snapshot, steps } = options;
  const { from, to } = snapshot.manifest;
  const failed = yield* rollBackOver(
    switchSteps(lock.home, { old: from, new: to }, steps),
    snapshot,
  );
  // The old release ran once only adopting it is left.
  const ran = Option.isNone(failed) || failed.value.step === "adopt";
  const recording =
    steps.supervised && ran
      ? yield* record(lock.home, from.version, Option.some(to.version))
      : Option.none<string>();
  return { failed, recording } satisfies RollbackResult;
});
