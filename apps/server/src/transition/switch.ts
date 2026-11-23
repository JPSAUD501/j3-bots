// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The part of a version transition that changes something, as one sequence
// of steps whose effects are given to it, so every way it can fail is told
// apart and tested (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md).
// `transition.ts` gives it the steps on the home; the host that runs the
// server (`j3-bots update` with its systemd service, the desktop app with its
// child process) gives it the steps that stop, start and adopt a release:
//
//   stop → snapshot → start the new release → wait for it → adopt it
//
// A failure before the new release starts leaves the databases untouched, and
// starts the old release again. A failure after it started rolls back: the
// snapshot put back and the old release started again. The new release is
// adopted (the CLI points its command at it) only once it is ready.
//
// A rollback, this one or the one the operator asks for, is one marked state
// from start to end:
//
//   mark → disable → restore → start the old release → wait for it → unmark
//
// The mark, in the snapshot's folder, is written before anything changes and
// removed only once the old release runs. While it is there a transition
// refuses, no server starts on the home but the old release once the
// snapshot is back whole, and the next rollback carries on from where it got.
// The supervisor is disabled from before the restore until the old release's
// start enables it again.

/** Which of the two releases a step is about. */
export type Side = "old" | "new";

/** A step that did not succeed, and why, in a sentence. */
export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  step: Schema.Literals([
    "stop",
    "snapshot",
    "start-new",
    "await-new",
    "mark",
    "restore",
    "start-old",
    "await-old",
    "unmark",
    "adopt",
  ]),
  reason: Schema.String,
}) {}

/** What the switch does, given to it. Each fails with a `StepFailed` naming itself. */
export interface SwitchSteps<Snapshot, R> {
  /** Whether a supervisor runs the server on the home. Without one, nothing is stopped or started. */
  readonly supervised: boolean;
  /** Stops the server, and clears its failed state. It stays enabled. */
  readonly stop: Effect.Effect<void, StepFailed, R>;
  /** Stops the server, clears its failed state, and disables it: nothing starts it until a `start`. */
  readonly disable: Effect.Effect<void, StepFailed, R>;
  /** Copies the databases and settings; a snapshot that fails leaves nothing behind. */
  readonly snapshot: Effect.Effect<Snapshot, StepFailed, R>;
  /** Marks a rollback to the snapshot as started; one a cut-off rollback marked stays as it is. */
  readonly mark: (snapshot: Snapshot) => Effect.Effect<void, StepFailed, R>;
  /** Starts that release's server, and enables it: the CLI runs that release's own `service install`. */
  readonly start: (side: Side) => Effect.Effect<void, StepFailed, R>;
  /** Waits, bounded, for the supervised server to answer as that release, its engine ready. */
  readonly ready: (side: Side) => Effect.Effect<void, StepFailed, R>;
  /** Puts the snapshot back, carrying on from where its mark says a cut-off one got. */
  readonly restore: (snapshot: Snapshot) => Effect.Effect<void, StepFailed, R>;
  /** Marks the rollback to the snapshot as finished. */
  readonly unmark: (snapshot: Snapshot) => Effect.Effect<void, StepFailed, R>;
  /**
   * Makes that release the one the host runs from now on, once its server
   * is ready: the CLI points its `j3-bots` command at it.
   */
  readonly adopt: (side: Side) => Effect.Effect<void, StepFailed, R>;
}

export type SwitchOutcome<Snapshot> =
  /**
   * The new release runs, adopted too unless `adopt` says why not: the
   * supervisor runs it either way, and its server became ready.
   */
  | {
      readonly _tag: "updated";
      readonly snapshot: Snapshot;
      readonly adopt: Option.Option<StepFailed>;
    }
  /**
   * The new release did not become ready, and the old one runs again, on the
   * databases as they were: put back from `snapshot` when the new release
   * had started.
   */
  | {
      readonly _tag: "rolled-back";
      readonly failed: StepFailed;
      readonly restored: Option.Option<Snapshot>;
    }
  /** The update failed, and so did bringing the old release back. */
  | {
      readonly _tag: "rollback-failed";
      readonly failed: StepFailed;
      readonly rollback: StepFailed;
      readonly snapshot: Option.Option<Snapshot>;
    };

/** What a rollback does, given to it: everything but stopping and taking a snapshot. */
export type RollbackSteps<Snapshot, R> = Omit<SwitchSteps<Snapshot, R>, "stop" | "snapshot">;

/**
 * Puts `snapshot` back and starts the old release, as one marked state
 * (above). Stops at the first step that fails; the mark stays, so the next
 * rollback carries on. It never adopts a release.
 */
const rollBackTo = Effect.fn("switch.rollBackTo")(function* <Snapshot, R>(
  steps: RollbackSteps<Snapshot, R>,
  snapshot: Snapshot,
) {
  yield* steps.mark(snapshot);
  if (steps.supervised) yield* steps.disable;
  yield* steps.restore(snapshot);
  if (steps.supervised) {
    yield* steps.start("old");
    yield* steps.ready("old");
  }
  yield* steps.unmark(snapshot);
});

/** Runs the switch to its end. Not interruptible: it always leaves one release in place. */
export const switchOver = <Snapshot, R>(
  steps: SwitchSteps<Snapshot, R>,
): Effect.Effect<SwitchOutcome<Snapshot>, never, R> =>
  Effect.gen(function* () {
    /** Starts the old release again, after `failed`, the databases put back from `snapshot` first. */
    const back = (failed: StepFailed, snapshot: Option.Option<Snapshot>) =>
      Effect.gen(function* () {
        if (Option.isSome(snapshot)) {
          yield* rollBackTo(steps, snapshot.value);
        } else if (steps.supervised) {
          yield* steps.start("old");
          yield* steps.ready("old");
        }
        return { _tag: "rolled-back", failed, restored: snapshot } as const;
      }).pipe(
        Effect.catch((rollback) =>
          Effect.succeed({ _tag: "rollback-failed", failed, rollback, snapshot } as const),
        ),
      );

    if (steps.supervised) {
      const stopped = yield* Effect.result(steps.stop);
      if (stopped._tag === "Failure") return yield* back(stopped.failure, Option.none());
    }
    const taken = yield* Effect.result(steps.snapshot);
    if (taken._tag === "Failure") return yield* back(taken.failure, Option.none());
    const snapshot = taken.success;
    if (steps.supervised) {
      const started = yield* Effect.result(Effect.andThen(steps.start("new"), steps.ready("new")));
      if (started._tag === "Failure") return yield* back(started.failure, Option.some(snapshot));
    }
    const adopted = yield* Effect.result(steps.adopt("new"));
    if (adopted._tag === "Failure" && !steps.supervised) {
      // No server ran on the new release: nothing to put back.
      return { _tag: "rolled-back", failed: adopted.failure, restored: Option.none() } as const;
    }
    return {
      _tag: "updated",
      snapshot,
      adopt: adopted._tag === "Failure" ? Option.some(adopted.failure) : Option.none(),
    } as const;
  }).pipe(Effect.uninterruptible);

/**
 * A rollback the operator asks for (`j3-bots update --rollback`), once they
 * agreed: the rollback to `snapshot` (above), then the old release adopted.
 * Not interruptible. Stops at the first step that fails, which it answers.
 */
export const rollBackOver = <Snapshot, R>(
  steps: RollbackSteps<Snapshot, R>,
  snapshot: Snapshot,
): Effect.Effect<Option.Option<StepFailed>, never, R> =>
  Effect.gen(function* () {
    yield* rollBackTo(steps, snapshot);
    yield* steps.adopt("old");
  }).pipe(
    Effect.as(Option.none<StepFailed>()),
    Effect.catch((failed) => Effect.succeedSome(failed)),
    Effect.uninterruptible,
  );
