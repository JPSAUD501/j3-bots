// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { HOME_ENTRIES } from "../home/entries.ts";
import { holdHome, holdUpdateLock } from "../home/Home.ts";
import {
  abandonRestore,
  listSnapshots,
  markRestoring,
  pruneSnapshots,
  requireBackupsBeside,
  restoreSnapshot,
  type Snapshot,
  type SnapshotRelease,
  takeSnapshot,
  transitionRoom,
  unmarkRestoring,
} from "../install/snapshot.ts";
import { isWithin, realLocation } from "../paths.ts";
import { awaitReady, type ServerProbe } from "./readiness.ts";
import { readRuntimeRecord, recordPending, recordReady, recordTransitioned } from "./record.ts";
import {
  abandonOver,
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
//   stop → snapshot (under server.lock) → record it pending → start V → ready
//        → adopt → record V → prune
//
// If V never becomes ready: restore the snapshot → start U → ready → record U,
// rolled back from V → unmark. The record is written before the mark goes,
// so a cut anywhere leaves either the mark, which the next rollback carries
// on from, or the record. A transition cut off after its snapshot leaves it
// pending in the record. The next one to V carries it on from U with that
// snapshot and never takes another; one to any other release first rolls the
// cut-off one back to U, with that snapshot, then moves from U as any
// transition does. Two releases, two snapshots and two engine runtimes are
// kept.

/** How many releases, snapshots and engine runtimes a transition keeps. */
const KEEP = 2;

/** A `TransitionLock` used after its scope closed, or by a second operation while one runs. */
export class TransitionLockUnusable extends Schema.TaggedError<TransitionLockUnusable>()(
  "TransitionLockUnusable",
  { home: Schema.String, reason: Schema.Literals(["released", "in-use"]) },
) {
  override get message(): string {
    return this.reason === "released"
      ? `The lock on ${this.home} was released: hold it again to change the home.`
      : `Another transition or rollback of ${this.home} runs under this lock.`;
  }
}

/**
 * This process's hold on a home's `<home>/backups/update.lock`, for the scope
 * it was taken in: one transition or rollback of the home at a time, the
 * CLI's and the desktop app's alike. Each runs under it with `use`, which
 * refuses once the scope closed or while another operation uses it.
 */
export class TransitionLock {
  readonly home: string;
  #state: "free" | "in-use" | "released" = "free";

  private constructor(home: string) {
    this.home = home;
  }

  /** Holds the lock of `home` for the scope, or fails with `busy()` at once while another holds it. */
  static readonly hold = Effect.fn("TransitionLock.hold")(function* <E>(
    home: string,
    busy: () => E,
  ) {
    yield* holdUpdateLock(home, busy);
    const lock = new TransitionLock(home);
    // Before the file lock is let go: finalizers run last added, first.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        lock.#state = "released";
      }),
    );
    return lock;
  });

  /** Runs `effect` as the one operation under this lock, or fails before it starts. */
  use<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (this.#state !== "free") {
          return Effect.fail(new TransitionLockUnusable({ home: this.home, reason: this.#state }));
        }
        this.#state = "in-use";
        return Effect.void;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          if (this.#state === "in-use") this.#state = "free";
        }),
    );
  }
}

/** What a host gives a transition: how its server is stopped, started, watched and adopted. */
export interface HostSteps<R> {
  /** Whether the host runs a server on the home. Without one, nothing is stopped or started. */
  readonly supervised: boolean;
  /** Stops the server, and clears its failed state. It stays enabled. */
  readonly stop: Effect.Effect<void, StepFailed, R>;
  /** Stops the server, clears its failed state, and disables it: nothing starts it until a `start`. */
  readonly disable: Effect.Effect<void, StepFailed, R>;
  /** Starts that release's server, from its own runtime, and enables it. */
  readonly start: (side: Side) => Effect.Effect<void, StepFailed, R>;
  /** What the host sees of the server it started for that release, now. */
  readonly probe: (side: Side) => Effect.Effect<ServerProbe, never, R>;
  /** The free space where `location` is, in bytes, when the host can tell. */
  readonly freeSpace: (location: string) => Effect.Effect<Option.Option<number>, never, R>;
  /** Makes that release the one the host runs from now on, once its server is ready. */
  readonly adopt: (side: Side) => Effect.Effect<void, StepFailed, R>;
  /** Removes the host's runtimes of every release but `keep`, the two a transition moved between. */
  readonly pruneRuntimes: (
    keep: readonly [string, string],
  ) => Effect.Effect<void, PlatformError.PlatformError, R>;
}

/** The host's steps for the two releases a transition settled on: the old one is what ran on the data. */
export type HostStepsFor<R> = (releases: Record<Side, SnapshotRelease>) => HostSteps<R>;

/** A transition cut off left its snapshot pending, and the snapshot is gone: nothing was changed. */
export class PendingSnapshotGone extends Schema.TaggedError<PendingSnapshotGone>()(
  "PendingSnapshotGone",
  { home: Schema.String, snapshot: Schema.String, from: Schema.String },
) {
  override get message(): string {
    return `A transition from J3 Bots ${this.from} on ${this.home} was cut off after its snapshot, ${this.snapshot}, which is no longer in backups/. The data may be the newer release's already, so no other snapshot stands in for it. Nothing was changed.`;
  }
}

/** The data directory has too little room for a transition's copies. Nothing was changed. */
class NoRoomOnHome extends Schema.TaggedError<NoRoomOnHome>()("NoRoomOnHome", {
  home: Schema.String,
  needed: Schema.Number,
  free: Schema.Number,
}) {
  override get message(): string {
    const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return `Copying the databases, and putting them back if the new release fails, needs ${gb(this.needed)} free where ${this.home} is, and ${gb(this.free)} is. Free some space, then try again. Nothing was changed.`;
  }
}

/** Fails when the home has too little room for a transition's copies, as far as `host` can tell. */
const requireRoom = Effect.fn("transition.requireRoom")(function* <R>(
  home: string,
  host: HostSteps<R>,
) {
  const needed = yield* transitionRoom(home);
  const free = yield* host.freeSpace(home);
  if (Option.isSome(free) && free.value < needed) {
    return yield* new NoRoomOnHome({ home, needed, free: free.value });
  }
});

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

/** The switch's steps: the host's, and the ones on the home, for the two releases. */
const switchSteps = <R>(
  home: string,
  releases: Record<Side, SnapshotRelease>,
  host: HostSteps<R>,
  resumed: Option.Option<Snapshot>,
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
  resumed,
  // Pending once the snapshot is whole, before the new release can migrate
  // anything; none is taken that a rollback could not put back, or without
  // the room to put it back.
  snapshot: withHome(
    home,
    "snapshot",
    Effect.tap(
      Effect.andThen(
        Effect.andThen(requireBackupsBeside(home), requireRoom(home, host)),
        takeSnapshot({ home, from: releases.old, to: releases.new }),
      ),
      (snapshot) =>
        Effect.flatMap(Path.Path, (path) =>
          recordPending(home, {
            from: releases.old,
            to: releases.new,
            snapshot: path.basename(snapshot.folder),
          }),
        ),
    ),
  ),
  mark: (snapshot) =>
    markRestoring(snapshot).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "mark", reason: cause.message })),
    ),
  restore: (snapshot) => withHome(home, "restore", restoreSnapshot(home, snapshot)),
  // The record says the old release's data is back, rolled back from the
  // release that failed, before the mark that keeps every other release off
  // the home goes.
  unmark: (snapshot) =>
    recordTransitioned(home, releases.old.version, Option.some(releases.new.version)).pipe(
      Effect.mapError(
        (cause) =>
          new StepFailed({
            step: "record",
            reason: `Writing the data directory's record of the release that runs, state/runtime.json, failed: ${cause.message}`,
          }),
      ),
      Effect.andThen(
        unmarkRestoring(snapshot).pipe(
          Effect.mapError((cause) => new StepFailed({ step: "unmark", reason: cause.message })),
        ),
      ),
    ),
  // The record says the data is the new release's, nothing pending, before
  // the mark that keeps that release off the home goes.
  forget: (snapshot) =>
    recordReady(home, releases.new.version).pipe(
      Effect.mapError(
        (cause) =>
          new StepFailed({
            step: "record",
            reason: `Writing the data directory's record of the release that runs, state/runtime.json, failed: ${cause.message}`,
          }),
      ),
      Effect.andThen(
        abandonRestore(home, snapshot).pipe(
          Effect.mapError((cause) => new StepFailed({ step: "unmark", reason: cause.message })),
        ),
      ),
    ),
});

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

/**
 * How a transition ended: the switch's outcome, or, when it found one cut
 * off on its way to another release and rolling that one back was all there
 * was to do, how that went: it failed, or `to` is the release it rolls back to.
 */
export type TransitionOutcome =
  | SwitchOutcome<Snapshot>
  | { readonly _tag: "cut-off-rolled-back"; readonly snapshot: Snapshot }
  | {
      readonly _tag: "cut-off-rollback-failed";
      readonly rollback: StepFailed;
      readonly snapshot: Snapshot;
    };

export interface TransitionResult {
  /** The release the transition moved from: what ran on the data its snapshot holds. */
  readonly from: SnapshotRelease;
  /** The release a transition cut off was moving to, when this one rolled it back first. */
  readonly interrupted: Option.Option<SnapshotRelease>;
  readonly outcome: TransitionOutcome;
  /** Why the new release could not be recorded once it ran: the next start carries the transition on. */
  readonly recording: Option.Option<string>;
  /** Why keeping two of everything failed, which leaves only more on disk. */
  readonly pruning: Option.Option<string>;
}

/**
 * Moves the home `lock` holds to release `to`, from `from`, the release that
 * ran on it, with the host's steps for the two, to its end: never
 * interrupted, it always leaves one release in place.
 *
 * When the record names a transition that was cut off, the home's data may
 * be the data of the release it was moving to already, so no snapshot is
 * taken of it. A transition to that release carries the cut-off one on, from
 * the release it started from and with its snapshot. One to any other
 * release first rolls the cut-off one back to the release it started from,
 * with that snapshot, then moves from there with a snapshot of its own. Only
 * once `to` runs is it recorded, and anything pruned.
 */
export const transition = Effect.fn("transition.transition")(function* <R>(options: {
  readonly lock: TransitionLock;
  readonly from: SnapshotRelease;
  readonly to: SnapshotRelease;
  readonly steps: HostStepsFor<R>;
}) {
  const { lock, to } = options;
  const { home } = lock;
  /** The switch from `from` to `to`, carrying on with `resumed` if one. */
  const switchFrom = Effect.fnUntraced(function* (
    from: SnapshotRelease,
    resumed: Option.Option<Snapshot>,
    interrupted: Option.Option<SnapshotRelease>,
  ) {
    const steps = options.steps({ old: from, new: to });
    const outcome = yield* switchOver(switchSteps(home, { old: from, new: to }, steps, resumed));
    const recording =
      outcome._tag === "updated"
        ? yield* recordTransitioned(home, to.version, Option.none()).pipe(
            Effect.as(Option.none<string>()),
            Effect.catch((cause) => Effect.succeedSome(cause.message)),
          )
        : Option.none<string>();
    const pruning =
      outcome._tag === "updated"
        ? yield* prune(home, from, to, steps).pipe(
            Effect.as(Option.none<string>()),
            Effect.catch((cause) => Effect.succeedSome(cause.message)),
          )
        : Option.none<string>();
    return { from, interrupted, outcome, recording, pruning } satisfies TransitionResult;
  });
  return yield* lock.use(
    Effect.gen(function* () {
      const recorded = yield* readRuntimeRecord(home);
      if (recorded._tag !== "recorded" || recorded.record.pending === undefined) {
        return yield* switchFrom(options.from, Option.none(), Option.none());
      }
      const pending = recorded.record.pending;
      const path = yield* Path.Path;
      const snapshot = (yield* listSnapshots(home)).find(
        ({ folder }) => path.basename(folder) === pending.snapshot,
      );
      if (snapshot === undefined) {
        return yield* new PendingSnapshotGone({
          home,
          snapshot: pending.snapshot,
          from: pending.from.version,
        });
      }
      if (pending.to.version === to.version) {
        return yield* switchFrom(pending.from, Option.some(snapshot), Option.none());
      }
      const cutOff = { old: pending.from, new: pending.to };
      const failed = yield* rollBackOver(
        switchSteps(home, cutOff, options.steps(cutOff), Option.some(snapshot)),
        snapshot,
      );
      const rolledBack = (outcome: TransitionOutcome): TransitionResult => ({
        from: pending.from,
        interrupted: Option.some(pending.to),
        outcome,
        recording: Option.none(),
        pruning: Option.none(),
      });
      if (Option.isSome(failed)) {
        return rolledBack({ _tag: "cut-off-rollback-failed", rollback: failed.value, snapshot });
      }
      if (pending.from.version === to.version) {
        return rolledBack({ _tag: "cut-off-rolled-back", snapshot });
      }
      return yield* switchFrom(pending.from, Option.none(), Option.some(pending.to));
    }),
  );
});

/**
 * Puts `snapshot` back on the home `lock` holds and starts the release it was
 * taken from, as one marked state, then adopts it: the rollback an operator
 * asks for, and the way an unfinished one is finished, from where it got.
 * The release is recorded, rolled back from the one the snapshot was taken
 * for, before the mark goes. Answers the step that failed, if one did.
 */
export const rollBack = Effect.fn("transition.rollBack")(function* <R>(options: {
  readonly lock: TransitionLock;
  readonly snapshot: Snapshot;
  readonly steps: HostStepsFor<R>;
}) {
  const { lock, snapshot } = options;
  const releases = { old: snapshot.manifest.from, new: snapshot.manifest.to };
  return yield* lock.use(
    rollBackOver(
      switchSteps(lock.home, releases, options.steps(releases), Option.some(snapshot)),
      snapshot,
    ),
  );
});

/**
 * A rollback that may have put part of its snapshot back, which only
 * finishing makes whole: its mark says it did, or, `unread`, cannot be read
 * once a swap had begun.
 */
class RollbackNotAbandonable extends Schema.TaggedError<RollbackNotAbandonable>()(
  "RollbackNotAbandonable",
  { snapshot: Schema.String, from: Schema.String, to: Schema.String, unread: Schema.Boolean },
) {
  override get message(): string {
    const why = this.unread
      ? "has a mark that cannot be read, and its swap had begun, so it may have put part of the snapshot back"
      : "has put part or all of the snapshot back";
    return `The rollback to J3 Bots ${this.from}, from ${this.snapshot}, ${why}: the data directory may no longer hold what J3 Bots ${this.to} ran on, and only finishing the rollback makes it whole. \`j3-bots update --rollback\` does. Nothing was changed.`;
  }
}

/**
 * Fails unless the rollback to `snapshot` has put nothing back: its mark, as
 * read, at `copying`.
 */
export const requireAbandonable = Effect.fn("transition.requireAbandonable")(function* (
  snapshot: Snapshot,
) {
  if (Option.exists(snapshot.restoring, ({ stage }) => stage === "copying")) return;
  return yield* new RollbackNotAbandonable({
    snapshot: snapshot.folder,
    from: snapshot.manifest.from.version,
    to: snapshot.manifest.to.version,
    unread: Option.exists(snapshot.restoring, ({ stage }) => stage === "unread"),
  });
});

/**
 * Gives up the rollback to `snapshot` on the home `lock` holds, which must
 * have put nothing back (its mark at `copying`): what the person asks for
 * when the snapshot cannot be put back, as when a file of it was lost. The
 * home still holds the data of the release the snapshot was taken for, its
 * `to`, so that release is recorded, the mark removed, and that release
 * started and adopted. The snapshot stays. Answers the step that failed, if
 * one did.
 */
export const abandonRollback = Effect.fn("transition.abandonRollback")(function* <R>(options: {
  readonly lock: TransitionLock;
  readonly snapshot: Snapshot;
  readonly steps: HostStepsFor<R>;
}) {
  const { lock, snapshot } = options;
  const releases = { old: snapshot.manifest.from, new: snapshot.manifest.to };
  yield* requireAbandonable(snapshot);
  return yield* lock.use(
    abandonOver(
      switchSteps(lock.home, releases, options.steps(releases), Option.some(snapshot)),
      snapshot,
    ),
  );
});
