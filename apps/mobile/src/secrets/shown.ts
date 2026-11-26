// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as Redacted from "effect/Redacted";

/** How long a value shown stays on screen, in ms. */
export const SHOWN_FOR = 30_000;

/** The values shown on a secret's page, by field. */
export interface ShownValues<K> {
  /** Shows `value` for `SHOWN_FOR`, from now: showing it again starts the time again. */
  readonly show: (key: K, value: Redacted.Redacted<string>) => void;
  readonly hide: (key: K) => void;
  readonly hideAll: () => void;
}

/**
 * The values shown on a secret's page, each hidden `SHOWN_FOR` after it was
 * shown. `onChange` hears every change, with every value shown then.
 */
export const shownValues = <K>(
  onChange: (values: ReadonlyMap<K, Redacted.Redacted<string>>) => void,
): ShownValues<K> => {
  const values = new Map<K, Redacted.Redacted<string>>();
  const timers = new Map<K, ReturnType<typeof setTimeout>>();
  const changed = () => onChange(new Map(values));
  const hide = (key: K) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (values.delete(key)) changed();
  };
  return {
    show: (key, value) => {
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => hide(key), SHOWN_FOR),
      );
      values.set(key, value);
      changed();
    },
    hide,
    hideAll: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (values.size === 0) return;
      values.clear();
      changed();
    },
  };
};
