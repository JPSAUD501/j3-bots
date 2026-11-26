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

const startedFirst = (a: LittleOne, b: LittleOne) =>
  DateTime.toEpochMillis(a.startedAt) - DateTime.toEpochMillis(b.startedAt);

const endedLast = (a: LittleOne, b: LittleOne) =>
  a.finishedAt === null || b.finishedAt === null
    ? 0
    : DateTime.toEpochMillis(b.finishedAt) - DateTime.toEpochMillis(a.finishedAt);

/**
 * The little ones a turn's work names, of `all` in the order they started:
 * every one, up to `MAX_LITTLE_ONES`; past that, every one still working,
 * then those that ended last.
 */
const named = (all: ReadonlyArray<LittleOne>): ReadonlyArray<LittleOne> => {
  if (all.length <= MAX_LITTLE_ONES) return all;
  const chosen = new Set(
    [...all.filter(isWorking), ...all.filter((one) => !isWorking(one)).toSorted(endedLast)]
      .slice(0, MAX_LITTLE_ONES)
      .map((one) => one.id),
  );
  return all.filter((one) => chosen.has(one.id));
};

/**
 * A turn's plan and little ones as the engine tells them, as clients are
 * shown them (`TurnWork`): null for a turn with neither. A turn with more
 * little ones than `MAX_LITTLE_ONES` names those `named` keeps, and counts
 * them all.
 */
export const shownWork = (work: EngineTurnWork): TurnWork | null => {
  const all = work.littleOnes;
  if (work.plan === null && all.length === 0) return null;
  return {
    plan: work.plan,
    littleOnes: {
      ones: named(all),
      working: all.filter(isWorking).length,
      total: all.length,
    },
  };
};

/**
 * What the engine tells of a turn that ended, with what was kept of it
 * before: a little one the engine no longer lists under the turn stays as it
 * was kept. A later turn can take a little one up again, and the engine then
 * lists it under that turn alone (decision 0070); the earlier turn still
 * started it, and saw it end.
 */
export const endedTurnWork = (kept: TurnWork, told: EngineTurnWork): EngineTurnWork => {
  const listed = new Set(told.littleOnes.map((one) => one.id));
  return {
    plan: told.plan ?? kept.plan,
    littleOnes: [
      ...kept.littleOnes.ones.filter((one) => !listed.has(one.id)),
      ...told.littleOnes,
    ].toSorted(startedFirst),
  };
};

/**
 * The work of a member's turns for a room that still run there, `earlier`
 * started first: the latest plan, and every little one of them, as one
 * turn's work would show them, since a little one an earlier turn handed off
 * still works beside the later turn. A little one both list, one the later
 * turn took up again, is the later turn's.
 */
export const joinedWork = (earlier: TurnWork, later: TurnWork): TurnWork => {
  const taken = new Set(later.littleOnes.ones.map((one) => one.id));
  const left = earlier.littleOnes.ones.filter((one) => !taken.has(one.id));
  const dropped = earlier.littleOnes.ones.filter((one) => taken.has(one.id));
  return {
    plan: later.plan ?? earlier.plan,
    littleOnes: {
      ones: named([...left, ...later.littleOnes.ones].toSorted(startedFirst)),
      working:
        earlier.littleOnes.working + later.littleOnes.working - dropped.filter(isWorking).length,
      total: earlier.littleOnes.total + later.littleOnes.total - dropped.length,
    },
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
