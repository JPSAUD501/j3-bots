// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

// Windows refuses to rename or remove a file another program has open, and
// to rename or remove a folder holding one. A scanner opens each new
// executable as it is written and as it first runs, and a process that ran
// one lets go of it only once it has ended: so for a moment after J3 Bots
// writes or runs a new executable, a rename or a removal of it, or of its
// folder, fails with `EBUSY`, `EPERM` or `EACCES`, though nothing is wrong.
// Trying again a little later, for a bounded time, is how Windows programs
// meet this (npm's `graceful-fs` does it for up to a minute).

/** The code Node gave a failed file operation, such as `ENOSPC` or `EBUSY`, when it gave one. */
export const errnoCode = (cause: unknown): string | null =>
  Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : null;

/** The code Node gave the operation `error` reports, when it gave one. */
export const platformErrorCode = (error: PlatformError.PlatformError): string | null =>
  error.reason._tag === "BadArgument" ? null : errnoCode(error.reason.cause);

/** The codes Windows gives a rename or a removal it refuses while another program holds the file. */
const HELD_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES"]);

/**
 * Whether a rename or a removal that failed with `code` on `platform` may
 * have been refused only because another program held the file a moment.
 */
export const heldOnWindows = (code: string | null, platform: string): boolean =>
  platform === "win32" && code !== null && HELD_CODES.has(code);

/** How long a rename or a removal is tried again while Windows says another program holds the file. */
export const HELD_PATIENCE = Duration.seconds(30);

/**
 * `operation`, a rename or a removal, tried again while it fails because
 * Windows says another program holds the file (`heldOnWindows`, from the
 * code `codeOf` reads in the failure): from 50 ms, doubling up to a second
 * apart, for `patience` at most. Any other failure, and any on another
 * system, is the operation's at once.
 */
export const whileHeld = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  options: {
    readonly platform: string;
    readonly codeOf: (error: E) => string | null;
    readonly patience?: Duration.Input;
  },
): Effect.Effect<A, E, R> =>
  operation.pipe(
    Effect.retry({
      while: (error: E) => heldOnWindows(options.codeOf(error), options.platform),
      schedule: Schedule.min([
        Schedule.exponential(Duration.millis(50)),
        Schedule.spaced(Duration.seconds(1)),
      ]).pipe(Schedule.upTo({ duration: options.patience ?? HELD_PATIENCE })),
    }),
  );

/**
 * What a file operation that failed with `code` comes down to, for the one
 * who must act on it:
 * - `storage`: the disk is full (`ENOSPC`), or the user's quota on it is
 *   (`EDQUOT`); the only failure free space mends;
 * - `in-use`: another program holds the file (`EBUSY`; for a rename or a
 *   removal, `moves`, also what `heldOnWindows` says Windows gives then);
 * - `permission`: the system does not let this process write there;
 * - `files`: anything else, which only the code itself tells.
 */
export type FileFailure = "storage" | "in-use" | "permission" | "files";

export const fileFailure = (
  code: string | null,
  options: { readonly platform: string; readonly moves: boolean },
): FileFailure => {
  if (code === "ENOSPC" || code === "EDQUOT") return "storage";
  if (code === "EBUSY" || (options.moves && heldOnWindows(code, options.platform))) {
    return "in-use";
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "permission";
  return "files";
};
