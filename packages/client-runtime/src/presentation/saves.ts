// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IntentFailure } from "../intents/Actions.ts";
import type { Save } from "../stores/Details.ts";

/** Why a save failed, as the form says it. */
export type SaveProblem =
  /** `Invalid("model")`: the engine no longer offers the model chosen. */
  | "model"
  /** `Conflict("stale-revision")`: the file changed after it was read. */
  | "stale"
  /** `Conflict("private-location")`: the memory folder was linked out of private data. */
  | "private-location"
  /** `NotFound`: the bot, or the file, is gone. */
  | "gone"
  | "failed";

function saveProblem(failure: IntentFailure): SaveProblem {
  if (failure._tag !== "refused") return "failed";
  const { error } = failure;
  switch (error._tag) {
    case "NotFound":
      return "gone";
    case "Invalid":
      return error.reason === "model" ? "model" : "failed";
    case "Conflict":
      return error.reason === "stale-revision"
        ? "stale"
        : error.reason === "private-location"
          ? "private-location"
          : "failed";
  }
}

/**
 * The problem a form shows for its latest save. Most show until the operator
 * edits again. A conflict holds until the newer version is read, since saving
 * again would send the same stale revision.
 */
export function shownSaveProblem(
  save: Save<unknown> | undefined,
  editedSince: boolean,
): SaveProblem | null {
  if (save?._tag !== "failed") return null;
  const problem = saveProblem(save.failure);
  return problem === "stale" || !editedSince ? problem : null;
}
