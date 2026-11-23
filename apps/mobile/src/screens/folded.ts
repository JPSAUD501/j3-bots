// SPDX-License-Identifier: AGPL-3.0-or-later
import { SectionId } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Storage } from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";

// Which roster sections the operator folded on this phone. Folding is the
// device's own (decision 0022): the server never hears of it, so another
// device keeps its own. Kept in expo-sqlite's key-value store beside the
// phone's other preferences, and read synchronously so the roster's first
// frame is already folded as it was left.

const KEY = "j3:roster:folded";

const Folded = Schema.fromJsonString(Schema.Array(SectionId));

const read = (): ReadonlySet<SectionId> => {
  let raw: string | null = null;
  try {
    raw = Storage.getItemSync(KEY);
  } catch {
    // A store that cannot be read leaves every section open.
  }
  return new Set(Option.getOrElse(Schema.decodeUnknownOption(Folded)(raw), () => []));
};

let current = read();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Folds the section, or opens it again. `present` are the sections the
 * roster has now: what is kept is only theirs, so a deleted section's fold
 * is forgotten the next time any is flipped.
 */
export function toggleFolded(sectionId: SectionId, present: ReadonlyArray<SectionId>): void {
  const next = new Set(present.filter((id) => current.has(id)));
  if (current.has(sectionId)) next.delete(sectionId);
  else next.add(sectionId);
  current = next;
  try {
    if (next.size === 0) Storage.removeItemSync(KEY);
    else Storage.setItemSync(KEY, Schema.encodeSync(Folded)([...next]));
  } catch {
    // The fold still holds until the app restarts; it is just not remembered.
  }
  for (const listener of listeners) listener();
}

/** The sections folded on this phone. */
export const useFolded = (): ReadonlySet<SectionId> =>
  useSyncExternalStore(subscribe, () => current);
