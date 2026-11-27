// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OrchestrationV2GetThreadProjectionError } from "@t3tools/contracts";

/** The engine's own error for a thread it has no record of (**Read** at `bc0f04d`, `ProjectionStore.ts`). */
const THREAD_NOT_FOUND = "ProjectionStoreThreadNotFoundError";

/**
 * Whether a failed read of a thread says the thread does not exist. The engine
 * reports every failure of the read in one error: a missing thread, a failed
 * projection read and a failed replay alike. Only its cause tells them apart:
 * the engine's errors cross the wire as a chain that keeps each one's name
 * (**Read** at `bc0f04d`, `ws.ts`, `getThreadProjection` and `subscribeThread`;
 * effect `Schema.Defect`). Anything else is a read that may succeed again.
 */
export const isMissingThread = (error: OrchestrationV2GetThreadProjectionError): boolean => {
  let cause: unknown = error.cause;
  // The wire drops a circular cause, so the chain ends.
  while (cause instanceof Error) {
    if (cause.name === THREAD_NOT_FOUND) return true;
    cause = cause.cause;
  }
  return false;
};
