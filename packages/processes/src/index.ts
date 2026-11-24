// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@j3-bots/processes`: starting and stopping programs the server runs, with
 * nothing of any one program's in it. On Windows, {@link inJob} runs a program
 * in a job object, so that nothing it started outlives it.
 */
export { inJob, type JobStdio } from "./job.ts";
export {
  POWERSHELL,
  powerShellArgs,
  powerShellLiteral,
  system32,
  windowsCommandWord,
  windowsCommandWords,
  withoutModulePath,
} from "./windows.ts";
