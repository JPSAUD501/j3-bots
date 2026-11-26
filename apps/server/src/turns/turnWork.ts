// SPDX-License-Identifier: AGPL-3.0-or-later
import { type LittleOne, MAX_LITTLE_ONES, TurnWork } from "@j3-bots/contracts";
import type { EngineTurnWork } from "@j3-bots/engine-t3";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { json } from "../persistence/columns.ts";

/** A turn's plan and little ones, as `turns.work_json` holds them when it has any. */
export const WorkJson = json(TurnWork);

/** `turns.work_json`: null for a turn with no plan and no little ones. */
export const WorkColumn = Schema.NullOr(WorkJson);

const encodeWork = Schema.encodeSync(WorkJson);

/** Whether two of a turn's works show the same. */
export const sameWork = (a: TurnWork | null, b: TurnWork | null) =>
  a === null || b === null ? a === b : encodeWork(a) === encodeWork(b);

const isWorking = (one: LittleOne) => one.status === "working";

const endedLast = (a: LittleOne, b: LittleOne) =>
  a.finishedAt === null || b.finishedAt === null
    ? 0
    : DateTime.toEpochMillis(b.finishedAt) - DateTime.toEpochMillis(a.finishedAt);

/**
 * A turn's plan and little ones as the engine tells them, as clients are
 * shown them (`TurnWork`): null for a turn with neither. A turn with more
 * little ones than `MAX_LITTLE_ONES` keeps every one still working, then
 * those that ended last, in the order they started, and counts them all.
 */
export const shownWork = (work: EngineTurnWork): TurnWork | null => {
  const all = work.littleOnes;
  if (work.plan === null && all.length === 0) return null;
  const working = all.filter(isWorking);
  const kept =
    all.length <= MAX_LITTLE_ONES
      ? all
      : (() => {
          const chosen = new Set(
            [...working, ...all.filter((one) => !isWorking(one)).toSorted(endedLast)]
              .slice(0, MAX_LITTLE_ONES)
              .map((one) => one.id),
          );
          return all.filter((one) => chosen.has(one.id));
        })();
  return {
    plan: work.plan,
    littleOnes: { ones: kept, working: working.length, total: all.length },
  };
};

/**
 * The work as it stands once nothing runs in the turn's session any more: a
 * little one still working there ended with it, as failed, at `at`.
 */
export const endedWork = (work: TurnWork, at: DateTime.Utc): TurnWork => ({
  ...work,
  littleOnes: {
    ...work.littleOnes,
    ones: work.littleOnes.ones.map((one) =>
      isWorking(one)
        ? {
            id: one.id,
            label: one.label,
            status: "failed",
            startedAt: one.startedAt,
            finishedAt: at,
          }
        : one,
    ),
    working: 0,
  },
});
