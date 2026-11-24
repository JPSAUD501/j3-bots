// SPDX-License-Identifier: AGPL-3.0-or-later

/** What `useSyncExternalStore` reads. */
export interface ExternalStore<A> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly get: () => A;
}

/** An open resource, as `heldStore` holds it. */
export interface Opened<A> {
  readonly get: () => A;
  readonly close: () => void;
}

/**
 * A store that opens its resource for its first subscriber and closes it
 * after the last, so a component that reads it holds the resource from its
 * commit until it unmounts or reads another store, as an effect would, and
 * nothing is opened while rendering. `open` is given the function that tells
 * the subscribers the value changed. Reads `empty` while nothing holds it.
 */
export function heldStore<A>(open: (notify: () => void) => Opened<A>, empty: A): ExternalStore<A> {
  const listeners = new Set<() => void>();
  let opened: Opened<A> | null = null;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (opened === null) {
        opened = open(notify);
        notify();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || opened === null) return;
        const closing = opened;
        opened = null;
        closing.close();
      };
    },
    get: () => (opened === null ? empty : opened.get()),
  };
}

/** A store that holds nothing. */
export const emptyStore = <A>(value: A): ExternalStore<A> => ({
  subscribe: () => () => {},
  get: () => value,
});
