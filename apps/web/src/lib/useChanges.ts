// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { firstSeen, see } from "../presentation/changes";

/**
 * How many times `value` has changed since the component mounted: 0 on the
 * first render, so whatever keys on it plays on a change and never on mount.
 */
export function useChanges<T>(value: T): number {
  const [seen, setSeen] = useState(() => firstSeen(value));
  const next = see(seen, value);
  // Storing what was seen during render, as React allows for state derived from a previous render.
  if (next !== seen) setSeen(next);
  return next.changes;
}
