// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, Room, TurnWork } from "@j3-bots/contracts";
import { litter } from "@j3-bots/design-tokens";
import { shownLittleOnes, shownPlan } from "./turnWork.ts";

/**
 * How long a member's place at the end of a room stays once its turn has
 * nothing left to show, in ms: long enough for its last little one to stand
 * grey, if it failed, and get home.
 */
export const MEMBER_WORK_LINGER = (litter.failed + litter.failedDuck + 0.6) * 1000;

/**
 * Whether a turn's work has something to draw now: a plan that shows as one,
 * or a little one at work. One step and nobody working is what the line that
 * says who is answering already covers.
 */
export const showsTurnWork = (work: TurnWork): boolean =>
  shownPlan(work) !== null || shownLittleOnes(work.littleOnes).shown.length > 0;

/** A member's plan and little ones as its room shows them. */
export interface MemberWork {
  readonly botId: BotId;
  readonly work: TurnWork;
}

/**
 * The members of `room` whose turn for it has a plan or little ones to show,
 * in member order: each gets its face and its work at the end of the room.
 * None in an archived room.
 */
export const roomMemberWork = (room: Room): ReadonlyArray<MemberWork> =>
  room.status === "active" ? room.memberWork.filter((member) => showsTurnWork(member.work)) : [];
