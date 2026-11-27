// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, Room, RoomId, Routine } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { littleOnesAtWork } from "../presentation/turnWork.ts";
import { calendarDaysAgo, formatAt } from "../presentation/time.ts";
import { type PresentationContext, presenceLine, usageLimitText } from "./status.ts";
import { timeInSentence, type TimeContext } from "./time.ts";

/**
 * Where a bot stands, as its card's dot says (decision 0102): at work, waiting
 * on the operator, free, paused by a usage limit, or stopped by another
 * problem. The roster's states, in five.
 */
export type CardStatus = "working" | "waiting" | "free" | "paused" | "stuck";

export function cardStatus(bot: Bot): CardStatus {
  const { state } = bot;
  switch (state._tag) {
    case "idle":
      return "free";
    case "thinking":
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "blocked":
      return state.failure === "usage-limit" ? "paused" : "stuck";
  }
}

/** How many of the bot's rooms a card names; the rest it counts. */
export const CARD_ROOMS = 3;

/** A room the bot is in, as its card names it. */
export interface CardRoom {
  readonly id: RoomId;
  readonly name: string;
}

/** What a bot's card says beyond its name and title, each line whole and in the reader's language. */
export interface CardLines {
  readonly status: CardStatus;
  /** The status beside its dot: "Working", "Free", "Paused, the limit resets at 4:15 PM". */
  readonly statusText: string;
  /**
   * While it works: what it is doing now in one line, and under it how many
   * little ones help and since when, if there is anything to say.
   */
  readonly now: { readonly doing: string; readonly detail: string } | null;
  /** Its job, as the operator or its maker wrote it; null when it has none. */
  readonly job: string | null;
  /** Who made it and when: "Ana created it on Nov 27, at your request". */
  readonly made: string;
  /** Its routines and the next run, once they are read; null while they load, or with none. */
  readonly routines: string | null;
  /** The rooms it is in, the first `CARD_ROOMS` by name; null when it is in none. */
  readonly rooms: { readonly text: string; readonly shown: ReadonlyArray<CardRoom> } | null;
}

/** A day inside a sentence: "today", "yesterday", "on Nov 27". */
function dayInSentence(at: DateTime.Utc, ctx: TimeContext): string {
  const { t } = ctx.i18n;
  const days = calendarDaysAgo(at, ctx);
  if (days === 0) return t("card.day.today");
  if (days === 1) return t("card.day.yesterday");
  const sameYear =
    formatAt(at, ctx, { year: "numeric" }) === formatAt(ctx.now, ctx, { year: "numeric" });
  return t("card.day.date", {
    date: formatAt(
      at,
      ctx,
      sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" },
    ),
  });
}

function statusText(bot: Bot, status: CardStatus, ctx: PresentationContext): string {
  const { t } = ctx.i18n;
  switch (status) {
    case "working":
      return t("card.status.working");
    case "waiting":
      return t("card.status.waiting");
    case "free":
      return t("card.status.free");
    case "paused":
      return bot.state._tag === "blocked"
        ? usageLimitText(bot.state.retryAt, ctx)
        : t("card.status.stuck");
    case "stuck":
      return t("card.status.stuck");
  }
}

function nowLines(bot: Bot, ctx: PresentationContext): CardLines["now"] {
  const { state } = bot;
  if (state._tag !== "thinking" && state._tag !== "working") return null;
  const doing = presenceLine(bot, ctx)?.text ?? ctx.i18n.t("presence.working");
  const helping = littleOnesAtWork(state);
  const since = timeInSentence(state.since, ctx);
  return {
    doing,
    detail:
      helping > 0
        ? ctx.i18n.plural("card.now.helping", helping, { since })
        : ctx.i18n.t("card.now.since", { since }),
  };
}

function madeText(bot: Bot, ctx: PresentationContext): string {
  const { t } = ctx.i18n;
  const day = dayInSentence(bot.createdAt, ctx);
  const maker = bot.madeBy;
  if (maker === undefined || maker.by === "unknown") return t("card.made.unknown", { day });
  if (maker.by === "operator") return t("card.made.you", { day });
  const name = maker.botId === null ? null : ctx.botName(maker.botId);
  return name === null ? t("card.made.goneBot", { day }) : t("card.made.bot", { name, day });
}

/**
 * Its routines in one line: how many, and when the next of those that are on
 * runs, when one is due. Nothing for a bot with none: the card leaves out
 * what is not there.
 */
function routinesText(routines: ReadonlyArray<Routine>, ctx: TimeContext): string | null {
  if (routines.length === 0) return null;
  const next = routines
    .flatMap((routine) =>
      routine.enabled && routine.nextRunAt !== null ? [routine.nextRunAt] : [],
    )
    .reduce<DateTime.Utc | null>(
      (soonest, at) => (soonest === null || DateTime.isLessThan(at, soonest) ? at : soonest),
      null,
    );
  return next === null
    ? ctx.i18n.plural("card.routines", routines.length)
    : ctx.i18n.plural("card.routines.next", routines.length, {
        when: timeInSentence(next, ctx),
      });
}

function roomsLine(rooms: ReadonlyArray<Room>, ctx: PresentationContext): CardLines["rooms"] {
  if (rooms.length === 0) return null;
  const shown = rooms.slice(0, CARD_ROOMS).map((room) => ({ id: room.id, name: room.name }));
  const quoted = shown.map((room) => ctx.i18n.t("card.rooms.name", { name: room.name }));
  const more = rooms.length - shown.length;
  const { locale } = ctx.i18n;
  return {
    shown,
    text:
      more === 0
        ? ctx.i18n.t("card.rooms", {
            rooms: new Intl.ListFormat(locale, { type: "conjunction" }).format(quoted),
          })
        : ctx.i18n.plural("card.rooms.more", more, {
            rooms: new Intl.ListFormat(locale, { type: "unit" }).format(quoted),
          }),
  };
}

/**
 * What a bot's card says, from what the client already holds: the bot, the
 * rooms of the roster, and its routines once read (null while they load).
 * Rooms are the active ones it is a member of, in the order given.
 */
export function cardLines(
  bot: Bot,
  rooms: ReadonlyArray<Room>,
  routines: ReadonlyArray<Routine> | null,
  ctx: PresentationContext,
): CardLines {
  const status = cardStatus(bot);
  const job = bot.profile.job.trim();
  return {
    status,
    statusText: statusText(bot, status, ctx),
    now: nowLines(bot, ctx),
    job: job === "" ? null : job,
    made: madeText(bot, ctx),
    routines: routines === null ? null : routinesText(routines, ctx),
    rooms: roomsLine(
      rooms.filter((room) => room.status === "active" && room.members.includes(bot.id)),
      ctx,
    ),
  };
}
