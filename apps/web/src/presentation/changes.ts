// SPDX-License-Identifier: AGPL-3.0-or-later

/** A value as last seen, and how many times it has changed since it was first seen. */
export interface Seen<T> {
  readonly value: T;
  readonly changes: number;
}

export const firstSeen = <T>(value: T): Seen<T> => ({ value, changes: 0 });

/** What was seen after `value`: `seen` itself while nothing changed, so there is nothing to store. */
export const see = <T>(seen: Seen<T>, value: T): Seen<T> =>
  Object.is(seen.value, value) ? seen : { value, changes: seen.changes + 1 };
