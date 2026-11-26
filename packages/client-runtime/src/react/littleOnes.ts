// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LittleOne, LittleOnes } from "@j3-bots/contracts";
import { useCallback, useState } from "react";
import { type ShownLittleOnes, shownLittleOnes } from "../presentation/littleOnes.ts";

/** A turn's little ones as a surface draws them. */
export interface LittleRows {
  /** Those that work now, and how many more do. */
  readonly shown: ShownLittleOnes;
  /**
   * Every one drawn: those that work, in their order, then those that no
   * longer do and are on their way home, until the family says they are there.
   */
  readonly rows: ReadonlyArray<LittleOne>;
  /** Told the ids the family's model still holds: the others are home, and no longer drawn. */
  readonly held: (ids: ReadonlyArray<string>) => void;
}

/**
 * The little ones a surface draws for a turn: `shownLittleOnes`, and with
 * them the ones that just stopped working, kept as they were until the model
 * that moves them (`presentation/littleOnes.ts`) reports them home.
 */
export function useLittleRows(littleOnes: LittleOnes | null, live: boolean): LittleRows {
  const shown = shownLittleOnes(littleOnes, live);
  const key = shown.ones.map((one) => one.id).join("\n");
  const [seen, setSeen] = useState({ key, ones: shown.ones });
  const [kept, setKept] = useState<ReadonlyArray<LittleOne>>([]);
  // Stored during render, as React allows for state derived from a previous render.
  if (seen.key !== key) {
    const left = seen.ones.filter((one) => !shown.ones.some((now) => now.id === one.id));
    setSeen({ key, ones: shown.ones });
    if (left.length > 0) setKept([...kept, ...left]);
  }
  const held = useCallback(
    (ids: ReadonlyArray<string>) =>
      setKept((current) => {
        const still = current.filter((one) => ids.includes(one.id));
        return still.length === current.length ? current : still;
      }),
    [],
  );
  return {
    shown,
    rows: [...shown.ones, ...kept.filter((one) => !shown.ones.some((now) => now.id === one.id))],
    held,
  };
}
