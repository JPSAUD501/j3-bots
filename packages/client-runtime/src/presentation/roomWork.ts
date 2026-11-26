// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, Room, TurnWork } from "@j3-bots/contracts";
import { shownPlan } from "./plan.ts";

/**
 * Whether a turn's work has something to draw now: a plan that shows as one,
 * or a little one at work. One step and nobody working is what the turn's own
 * line already says.
 */
export const showsTurnWork = (work: TurnWork): boolean =>
  shownPlan(work.plan) !== null || work.littleOnes.ones.some((one) => one.status === "working");

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
