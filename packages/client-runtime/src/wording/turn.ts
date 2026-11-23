// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, WorkFoldEntry } from "@j3-bots/contracts";
import { presenceLine, type PresentationContext, type StatusLine } from "./status.ts";
import { shortDuration } from "../presentation/time.ts";
import { workFoldTitle } from "./work.ts";

/**
 * The line beside a turn under way: what the bot is doing now, the same line
 * its header and roster row show. Out of touch with the server, the client
 * cannot know, so the line says only what it last saw.
 */
export function turnLine(bot: Bot, offline: boolean, ctx: PresentationContext): StatusLine {
  if (offline) return { text: ctx.i18n.t("work.offline"), tone: "secondary" };
  return presenceLine(bot, ctx) ?? { text: ctx.i18n.t("presence.working"), tone: "default" };
}

/** A turn under way, as assistive technology reads its row: the line, and how long so far. */
export function turnLabel(line: StatusLine, elapsedMs: number, ctx: PresentationContext): string {
  return ctx.i18n.t("work.live", {
    status: line.text,
    duration: shortDuration(elapsedMs, ctx.i18n),
  });
}

export interface Announcement {
  /** Changes once per thing worth saying: a clock tick or a minute more of quiet never changes it. */
  readonly key: string;
  readonly text: string;
}

/**
 * What a bot's conversation says aloud about it, politely: each change of
 * state and each new line while it works, then how its turn ended. `ended`
 * is the fold of the turn last seen under way, once that turn is over: the
 * line it folds into is what is said then, once the fold has finished.
 */
export function turnAnnouncement(
  bot: Bot,
  ended: WorkFoldEntry | null,
  ctx: PresentationContext,
): Announcement {
  if (ended !== null) {
    return ended.status._tag === "running"
      ? { key: `ending-${ended.id}`, text: "" }
      : { key: `ended-${ended.id}`, text: workFoldTitle(ended, ctx) };
  }
  const { state } = bot;
  const text = presenceLine(bot, ctx)?.text ?? "";
  switch (state._tag) {
    case "thinking":
    case "working":
      // A stalled line counts its quiet: said once, not again each minute.
      return { key: state.stalled ? `${state._tag}:stalled` : `${state._tag}:${text}`, text };
    case "waiting":
    case "blocked":
    case "idle":
      return { key: state._tag, text };
  }
}
