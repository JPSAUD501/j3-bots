// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * State the server owns, as a client holds it. `loading` until the first
 * answer; then `ready`, keeping the last value through a disconnection with
 * `stale` set, so the UI never blanks and never shows old state as current.
 */
export type Synced<A> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly value: A; readonly stale: boolean };

export const loading: Synced<never> = { _tag: "loading" };

export const ready = <A>(value: A): Synced<A> => ({ _tag: "ready", value, stale: false });

export const markStale = <A>(synced: Synced<A>): Synced<A> =>
  synced._tag === "ready" && !synced.stale ? { ...synced, stale: true } : synced;
