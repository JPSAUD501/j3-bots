// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, WorkFoldEntry } from "@j3-bots/contracts";
import { liveTurn } from "../presentation/turn.ts";
import { presenceLine, type PresentationContext, type StatusLine } from "./status.ts";
import { workFoldTitle } from "./work.ts";

/**
 * The line beside a turn under way: what the bot is doing now, as its roster
 * row says it. Out of touch with the server, the client cannot know, so the
 * line says it is only what it last knew.
 */
export function turnLine(bot: Bot, offline: boolean, ctx: PresentationContext): StatusLine {
  const { t } = ctx.i18n;
  const line = presenceLine(bot, ctx) ?? { text: t("presence.working"), tone: "default" };
  if (!offline) return line;
  return { text: t("work.offline", { status: line.text }), tone: "secondary" };
}

export interface Announcement {
  /** Changes once per thing worth saying: a minute more of quiet never changes it. */
  readonly key: string;
  readonly text: string;
  /** How a turn ended: said once, however often the bot comes back to it. */
  readonly ending: boolean;
}

/**
 * What a bot's conversation says aloud about it, politely: each change of
 * state and each new line while it works, then how its turn ended. `ended`
 * is the fold of the turn last seen under way, once that turn is over: while
 * the bot is idle, the line it folds into is what is said, once the fold has
 * finished; any other state is said as itself. Out of touch with the server
 * while a turn runs, it says once that what it shows is only what it last
 * knew, and the state again once back.
 */
export function turnAnnouncement(
  bot: Bot,
  ended: WorkFoldEntry | null,
  offline: boolean,
  ctx: PresentationContext,
): Announcement {
  const { state } = bot;
  if (offline && liveTurn(bot) !== null) {
    return { key: "offline", text: turnLine(bot, true, ctx).text, ending: false };
  }
  if (state._tag === "idle" && ended !== null) {
    return ended.status._tag === "running"
      ? { key: `ending-${ended.id}`, text: "", ending: false }
      : { key: `ended-${ended.id}`, text: workFoldTitle(ended, ctx), ending: true };
  }
  const text = presenceLine(bot, ctx)?.text ?? "";
  switch (state._tag) {
    case "thinking":
    case "working":
      return { key: `${state._tag}:${text}`, text, ending: false };
    case "waiting":
    case "blocked":
    case "idle":
      return { key: state._tag, text, ending: false };
  }
}

/** What a conversation has said about its bot so far. */
export interface Spoken {
  /** The key of the announcement last made, or the one current as the conversation opened. */
  readonly key: string | null;
  /** The key of the ending last said. */
  readonly ending: string | null;
}

/**
 * Moves what was said on to `said`: the text to say now, or null when there
 * is nothing new. An ending is said once, however often the bot comes back
 * to it, as it does idling again after a question it asked.
 */
export function nextSpoken(
  spoken: Spoken,
  said: Announcement | null,
): { readonly spoken: Spoken; readonly say: string | null } {
  const key = said?.key ?? null;
  if (said === null || key === spoken.key) return { spoken: { ...spoken, key }, say: null };
  if (said.ending && said.key === spoken.ending) return { spoken: { ...spoken, key }, say: null };
  return {
    spoken: { key, ending: said.ending ? said.key : spoken.ending },
    say: said.text === "" ? null : said.text,
  };
}
