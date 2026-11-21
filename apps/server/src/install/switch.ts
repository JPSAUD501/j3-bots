// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The part of `j3-bots update` that changes something, as one sequence of
// steps whose effects are given to it, so every way it can fail is told
// apart and tested (docs/decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md):
//
//   stop → snapshot → start the new release → wait for it → point the command at it
//
// A failure before the new release starts leaves the databases untouched, and
// starts the old release again. A failure after it started stops it, puts the
// snapshot back and starts the old release again: the new server never
// answered as ready, so no turn ran on the new databases. The unit is only
// ever written by a release's own `service install`, so it names one release
// whole, and the command is pointed at the new release only once it is ready.

/** Which of the two releases a step is about. */
export type Side = "old" | "new";

/** A step that did not succeed, and why, in a sentence. */
export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  step: Schema.Literals([
    "stop",
    "snapshot",
    "start-new",
    "await-new",
    "restore",
    "start-old",
    "await-old",
    "command",
  ]),
  reason: Schema.String,
}) {}

/** What the switch does, given to it. Each fails with a `StepFailed` naming itself. */
export interface SwitchSteps<Snapshot, R> {
  /** Whether a service runs this install. Without one, nothing is stopped or started. */
  readonly service: boolean;
  /** Stops the service, and clears its failed state. */
  readonly stop: Effect.Effect<void, StepFailed, R>;
  /** Copies the databases and settings; a snapshot that fails leaves nothing behind. */
  readonly snapshot: Effect.Effect<Snapshot, StepFailed, R>;
  /** Runs that release's own `service install`, which writes the unit for it and starts it. */
  readonly start: (side: Side) => Effect.Effect<void, StepFailed, R>;
  /** Waits, bounded, for the service's server to answer as that release, its engine ready. */
  readonly ready: (side: Side) => Effect.Effect<void, StepFailed, R>;
  readonly restore: (snapshot: Snapshot) => Effect.Effect<void, StepFailed, R>;
  /** Points the j3-bots command at the new release. */
  readonly pointCommand: Effect.Effect<void, StepFailed, R>;
}

export type SwitchOutcome<Snapshot> =
  /**
   * The new release runs, from the command too unless `command` says why
   * not: the service is updated either way, and its server became ready.
   */
  | {
      readonly _tag: "updated";
      readonly snapshot: Snapshot;
      readonly command: Option.Option<StepFailed>;
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

/** Runs the switch to its end. Not interruptible: it always leaves one release in place. */
export const switchOver = <Snapshot, R>(
  steps: SwitchSteps<Snapshot, R>,
): Effect.Effect<SwitchOutcome<Snapshot>, never, R> =>
  Effect.gen(function* () {
    /** Starts the old release again, after `failed`, the databases put back from `snapshot` first. */
    const back = (failed: StepFailed, snapshot: Option.Option<Snapshot>) =>
      Effect.gen(function* () {
        if (Option.isSome(snapshot)) {
          if (steps.service) yield* steps.stop;
          yield* steps.restore(snapshot.value);
        }
        if (steps.service) {
          yield* steps.start("old");
          yield* steps.ready("old");
        }
        return { _tag: "rolled-back", failed, restored: snapshot } as const;
      }).pipe(
        Effect.catch((rollback) =>
          Effect.succeed({ _tag: "rollback-failed", failed, rollback, snapshot } as const),
        ),
      );

    if (steps.service) {
      const stopped = yield* Effect.result(steps.stop);
      if (stopped._tag === "Failure") return yield* back(stopped.failure, Option.none());
    }
    const taken = yield* Effect.result(steps.snapshot);
    if (taken._tag === "Failure") return yield* back(taken.failure, Option.none());
    const snapshot = taken.success;
    if (steps.service) {
      const started = yield* Effect.result(Effect.andThen(steps.start("new"), steps.ready("new")));
      if (started._tag === "Failure") return yield* back(started.failure, Option.some(snapshot));
    }
    const pointed = yield* Effect.result(steps.pointCommand);
    if (pointed._tag === "Failure" && !steps.service) {
      // No server ran on the new release: nothing to put back.
      return { _tag: "rolled-back", failed: pointed.failure, restored: Option.none() } as const;
    }
    return {
      _tag: "updated",
      snapshot,
      command: pointed._tag === "Failure" ? Option.some(pointed.failure) : Option.none(),
    } as const;
  }).pipe(Effect.uninterruptible);
