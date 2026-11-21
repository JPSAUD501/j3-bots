// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Cause from "effect/Cause";

/**
 * What failed, named by its tag (or its class, for a plain error) and never by
 * its message: a push's failure can quote what a row holds, such as a token or
 * the words of a push, which are kept out of the logs.
 */
export const failureTag = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause);
  if (typeof failure === "object" && failure !== null) {
    if ("_tag" in failure && typeof failure._tag === "string") return failure._tag;
    if (failure instanceof Error) return failure.name;
  }
  return "defect";
};
