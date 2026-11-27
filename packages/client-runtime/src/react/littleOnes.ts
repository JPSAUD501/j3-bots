// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LittleOne, LittleOnes, WorkFoldEntry } from "@j3-bots/contracts";
import { useCallback, useState } from "react";
import { type DrawnLittleOnes, drawnLittleOnes } from "../presentation/littleOnes.ts";
import { littleOnesOut } from "../presentation/turnWork.ts";

/** A turn's little ones as a surface draws them. */
export interface LittleRows {
  /** Those that work now, and how many more do. */
  readonly shown: DrawnLittleOnes;
  /**
   * Every one drawn: those that work, in their order, then those that no
   * longer do and are on their way home, until the family says they are there.
   */
  readonly rows: ReadonlyArray<LittleOne>;
  /** Told the ids the family's model still holds: the others are home, and no longer drawn. */
  readonly held: (ids: ReadonlyArray<string>) => void;
}

/**
 * The little ones a surface draws for a turn: `drawnLittleOnes`, and with
 * them the ones that just stopped working, kept as they were until the model
 * that moves them (`presentation/littleOnes.ts`) reports them home.
 */
export function useLittleRows(littleOnes: LittleOnes | null, live: boolean): LittleRows {
  const shown = drawnLittleOnes(littleOnes, live);
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

/**
 * How a turn's row stands: `running` while its turn runs; `out` once it has
 * ended with little ones it handed off still at work, or the last of them
 * still on its way home; `folded` into its line once they are all home.
 * Under `running` and `out` the row keeps the bot's face, with its little
 * ones under it (decision 0095).
 */
export type TurnRowShape = "running" | "out" | "folded";

export interface TurnRow {
  readonly shape: TurnRowShape;
  /**
   * The row folded into its line while it was shown, so the line arrives; a
   * row that was folded when it mounted is simply there.
   */
  readonly folding: boolean;
  /**
   * The family tells whether any little one is drawn: once none works, the
   * last keeps the row until it is home.
   */
  readonly drawn: (drawn: boolean) => void;
}

/** The shape of a turn's row, from its fold and whether its turn runs. */
export function useTurnRow(fold: WorkFoldEntry | null, live: boolean): TurnRow {
  const out = !live && littleOnesOut(fold);
  const [drawn, setDrawn] = useState(false);
  // Stored during render, as React allows for state derived from a previous render.
  const [wasOut, setWasOut] = useState(out);
  if (out && !wasOut) setWasOut(true);
  const shape: TurnRowShape = live ? "running" : out || (wasOut && drawn) ? "out" : "folded";
  const [shown, setShown] = useState(shape !== "folded");
  if (shape !== "folded" && !shown) setShown(true);
  return { shape, folding: shape === "folded" && shown, drawn: setDrawn };
}
