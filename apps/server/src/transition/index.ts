// SPDX-License-Identifier: AGPL-3.0-or-later
// The version transition core, for a host of a server other than the CLI:
// `@j3-bots/server/transition`. A host about to start release V on a home
// reads its record and the rollback it may have left unfinished, asks
// `decideStart`, and then:
//
// - `start`: starts V as it is, and `recordReady` once it answers ready;
// - `snapshot-then-start`: holds the home's `TransitionLock` and runs
//   `transition` from the recorded release to V with its own `HostSteps`;
// - `refuse-*`: starts nothing, and says why.
//
// A rollback left unfinished (`unfinishedRollback`) is the one thing that
// may start on its home: `decideStart` lets only its release start, and
// `rollBack` with its snapshot finishes it from where it got.

export { type ServerProbe, READY_WITHIN } from "./readiness.ts";
export {
  compareVersions,
  decideStart,
  readRuntimeRecord,
  recordReady,
  type RecordedRuntime,
  type RuntimeRecord,
  type StartDecision,
  type StartFacts,
} from "./record.ts";
export { type Side, StepFailed, type SwitchOutcome } from "./switch.ts";
export {
  type HostSteps,
  rollBack,
  type RollbackResult,
  transition,
  TransitionLock,
  type TransitionResult,
} from "./transition.ts";
export {
  listSnapshots,
  type Snapshot,
  type SnapshotRelease,
  unfinishedRollback,
} from "../install/snapshot.ts";
