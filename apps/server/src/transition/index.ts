// SPDX-License-Identifier: AGPL-3.0-or-later
// The version transition core, for a host of a server other than the CLI:
// `@j3-bots/server/transition`. A host about to start release V on a home
// reads its record and the rollback it may have left unfinished, asks
// `decideStart`, and then:
//
// - `start`: starts V as it is, and `recordReady` once it answers ready;
// - `snapshot-then-start`: holds the home's `TransitionLock` and runs
//   `transition` from the release that ran to V with its own `HostSteps`.
//   A transition to V that was cut off is carried on, with its snapshot; one
//   to another release is rolled back first, which the result names
//   (`interrupted`);
// - `refuse-rolled-back`: starts the recorded release, and tries V again
//   only when the person asks, with `transition`;
// - `refuse-*`: starts nothing, and says why; for an unreadable record, the
//   person may `setAsideRecord`.
//
// A rollback left unfinished (`unfinishedRollback`) is the one thing that
// may start on its home: `decideStart` lets only its release start, and
// `rollBack` with its snapshot finishes it from where it got.

export { type ServerProbe, READY_WITHIN } from "./readiness.ts";
export {
  compareVersions,
  decideStart,
  type PendingTransition,
  readRuntimeRecord,
  recordReady,
  type RecordedRuntime,
  type RuntimeRecord,
  setAsideRecord,
  type StartDecision,
  type StartFacts,
} from "./record.ts";
export { type Side, StepFailed, type SwitchOutcome } from "./switch.ts";
export {
  type HostSteps,
  type HostStepsFor,
  PendingSnapshotGone,
  rollBack,
  transition,
  TransitionLock,
  TransitionLockUnusable,
  type TransitionOutcome,
  type TransitionResult,
} from "./transition.ts";
export {
  listSnapshots,
  type Snapshot,
  type SnapshotRelease,
  unfinishedRollback,
} from "../install/snapshot.ts";
