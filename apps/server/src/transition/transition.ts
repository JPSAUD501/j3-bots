// SPDX-License-Identifier: AGPL-3.0-or-later
import * as EngineLive from "@j3-bots/engine-t3/live";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { HOME_ENTRIES } from "../home/entries.ts";
import { holdHome, holdLock } from "../home/Home.ts";
import {
  listSnapshots,
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
import { readRuntimeRecord, recordPending, recordTransitioned } from "./record.ts";
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
//   stop → snapshot (under server.lock) → record it pending → start V → ready
//        → adopt → record V → prune
//
// If V never becomes ready: restore the snapshot → start U → ready → record U,
// rolled back from V → unmark. The record is written before the mark goes,
// so a cut anywhere leaves either the mark, which the next rollback carries
// on from, or the record. A transition cut off after its snapshot leaves it
// pending in the record; the next one carries on from U with that snapshot
// and never takes another. Two releases, two snapshots and two engine
// runtimes are kept.

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
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const backups = path.join(home, HOME_ENTRIES.backups);
    yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 });
    yield* holdLock(path.join(backups, UPDATE_LOCK), busy);
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
  // anything. Without a server to start, nothing migrates in the transition.
  snapshot: withHome(
    home,
    "snapshot",
    Effect.tap(takeSnapshot({ home, from: releases.old, to: releases.new }), (snapshot) =>
      host.supervised
        ? Effect.flatMap(Path.Path, (path) =>
            recordPending(home, {
              from: releases.old,
              to: releases.new,
              snapshot: path.basename(snapshot.folder),
            }),
          )
        : Effect.void,
    ),
  ),
  mark: (snapshot) =>
    markRestoring(snapshot).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "mark", reason: cause.message })),
    ),
  restore: (snapshot) => withHome(home, "restore", restoreSnapshot(home, snapshot)),
  // The record says the old release runs, rolled back, before the mark that
  // keeps every other release off the home goes.
  unmark: (snapshot) =>
    (host.supervised
      ? recordTransitioned(
          home,
          snapshot.manifest.from.version,
          Option.some(snapshot.manifest.to.version),
        )
      : Effect.void
    ).pipe(
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

export interface TransitionResult {
  /** The release the transition moved from: what ran on the data its snapshot holds. */
  readonly from: SnapshotRelease;
  readonly outcome: SwitchOutcome<Snapshot>;
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
 * When the record names a transition that was cut off, this carries it on
 * instead: from the release that transition started from, with the snapshot
 * it took, so no snapshot is ever taken of data a new release may have
 * migrated. Only once `to` runs is it recorded, and anything pruned.
 */
export const transition = Effect.fn("transition.transition")(function* <R>(options: {
  readonly lock: TransitionLock;
  readonly from: SnapshotRelease;
  readonly to: SnapshotRelease;
  readonly steps: HostStepsFor<R>;
}) {
  const { lock, to } = options;
  const { home } = lock;
  return yield* lock.use(
    Effect.gen(function* () {
      const recorded = yield* readRuntimeRecord(home);
      const pending =
        recorded._tag === "recorded" && recorded.record.pending !== undefined
          ? Option.some(recorded.record.pending)
          : Option.none();
      const from = Option.match(pending, { onNone: () => options.from, onSome: (p) => p.from });
      const path = yield* Path.Path;
      const resumed = yield* Option.match(pending, {
        onNone: () => Effect.succeedNone,
        onSome: (p) =>
          Effect.flatMap(listSnapshots(home), (snapshots) => {
            const found = snapshots.find(({ folder }) => path.basename(folder) === p.snapshot);
            return found === undefined
              ? Effect.fail(
                  new PendingSnapshotGone({ home, snapshot: p.snapshot, from: p.from.version }),
                )
              : Effect.succeedSome(found);
          }),
      });
      const steps = options.steps({ old: from, new: to });
      const outcome = yield* switchOver(switchSteps(home, { old: from, new: to }, steps, resumed));
      const recording =
        steps.supervised && outcome._tag === "updated"
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
      return { from, outcome, recording, pruning } satisfies TransitionResult;
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
