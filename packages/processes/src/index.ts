// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@j3-bots/processes`: starting and stopping programs the server runs, with
 * nothing of any one program's in it, and the lock one process at a time
 * holds on a file ({@link holdLock}). On Windows, {@link inJob} runs a program
 * in a job object, so that nothing it started outlives it, and
 * {@link windowsNameKey} compares names as its file systems do, and
 * {@link whileHeld} retries a rename or a removal it refuses while another
 * program holds the file a moment.
 */
export { inJob, type JobStdio, jobLauncher } from "./job.ts";
export {
  errnoCode,
  type FileFailure,
  fileFailure,
  HELD_PATIENCE,
  heldOnWindows,
  platformErrorCode,
  whileHeld,
} from "./heldFiles.ts";
export { holdLock, holdLockWaiting, LockUnusable } from "./lock.ts";
export {
  POWERSHELL,
  powerShellArgs,
  powerShellLiteral,
  system32,
  windowsCommandWord,
  windowsCommandWords,
  windowsNameKey,
  withoutModulePath,
} from "./windows.ts";
