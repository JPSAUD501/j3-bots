// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { NonNegativeInt, OpenLiterals } from "./base.ts";

// J3 Bots' own copy of a harness: the Claude Code or Codex it downloads from
// the harness's publisher, checks and keeps up to date in the server's data
// directory, for a machine that has none of its own
// (docs/decisions/0045-j3-bots-keeps-its-own-copies-of-the-harnesses.md).

/** A harness version as its publisher numbers it, such as `2.1.326` or `0.172.0`. */
export const HarnessVersion = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
);
export type HarnessVersion = typeof HarnessVersion.Type;

/**
 * Why an install or an update of J3 Bots' copy did not finish:
 * - `unreachable`: the publisher's version listing or its download could not
 *   be read, or the download was cut off;
 * - `checksum`: what arrived is not what the publisher's checksum says, or the
 *   publisher gave no checksum for it;
 * - `check`: the new copy did not run, or did not say it is the version the
 *   publisher listed;
 * - `storage`: it could not be written into the server's data directory, as
 *   on a full disk;
 * - `engine`: the engine could not take the new copy, as when it was down;
 *   the provider keeps the copy it ran;
 * - `unknown`, as a client reads it: a reason a newer server gives.
 */
export const harnessInstallFailures = [
  "unreachable",
  "checksum",
  "check",
  "storage",
  "engine",
] as const;
export const HarnessInstallFailure = OpenLiterals(harnessInstallFailures);
export type HarnessInstallFailure = typeof HarnessInstallFailure.Type;

/**
 * What an install or an update is doing now:
 * - `downloading`: `receivedBytes` of `totalBytes`, null when the publisher
 *   does not say the size; updated at most about once a second;
 * - `verifying`: checking the download against the publisher's checksum,
 *   unpacking it and running the new copy once;
 * - `waiting`: the new copy is ready, and waits for the bots on the provider
 *   to finish what they run, since switching to it ends the harness's
 *   processes. It switches as soon as none runs.
 */
export const HarnessTask = Schema.Union([
  Schema.TaggedStruct("downloading", {
    receivedBytes: NonNegativeInt,
    totalBytes: Schema.NullOr(NonNegativeInt),
  }),
  Schema.TaggedStruct("verifying", {}),
  Schema.TaggedStruct("waiting", {}),
]);
export type HarnessTask = typeof HarnessTask.Type;

/** How the last install or update of J3 Bots' copy ended. */
export const HarnessOutcome = Schema.Union([
  /** The provider runs `version` since `at`. */
  Schema.TaggedStruct("installed", { version: HarnessVersion, at: Schema.DateTimeUtc }),
  Schema.TaggedStruct("failed", { reason: HarnessInstallFailure, at: Schema.DateTimeUtc }),
  Schema.TaggedStruct("cancelled", { at: Schema.DateTimeUtc }),
]);
export type HarnessOutcome = typeof HarnessOutcome.Type;

/**
 * Where the harness a Claude Code or Codex provider runs comes from, and J3
 * Bots' own copy of it:
 * - `source`: `j3` when the provider runs J3 Bots' copy; `operator` when it
 *   runs the one the operator installed, found on the server's `PATH`, which
 *   J3 Bots never changes; `none` when there is neither;
 * - `version`: the version of J3 Bots' copy, when the provider runs it;
 * - `latest`: the newest version the publisher listed at the last check,
 *   null before one answered;
 * - `installable`: the publisher ships a build J3 Bots installs for the
 *   server's system and processor;
 * - `task`: what an install or update is doing now, null when none runs;
 * - `last`: how the last one ended, null before the first.
 */
export const HarnessCopy = Schema.Struct({
  source: Schema.Literals(["j3", "operator", "none"]),
  version: Schema.NullOr(HarnessVersion),
  latest: Schema.NullOr(HarnessVersion),
  installable: Schema.Boolean,
  task: Schema.NullOr(HarnessTask),
  last: Schema.NullOr(HarnessOutcome),
});
export type HarnessCopy = typeof HarnessCopy.Type;

/** A version's numbers and its pre-release, if any, as SemVer orders them. */
const partsOf = (version: HarnessVersion) => {
  const dash = version.indexOf("-");
  const core = dash === -1 ? version : version.slice(0, dash);
  return {
    numbers: core.split(".").map(Number),
    prerelease: dash === -1 ? null : version.slice(dash + 1),
  };
};

/**
 * Whether `candidate` is a later version than `installed`, as SemVer orders
 * them: by their numbers, then a release after its pre-releases. Two
 * pre-releases of the same numbers are told apart by their text alone.
 */
export const isNewerHarness = (candidate: HarnessVersion, installed: HarnessVersion): boolean => {
  const a = partsOf(candidate);
  const b = partsOf(installed);
  for (let index = 0; index < 3; index++) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  if (a.prerelease === b.prerelease) return false;
  if (a.prerelease === null) return true;
  if (b.prerelease === null) return false;
  return a.prerelease > b.prerelease;
};
