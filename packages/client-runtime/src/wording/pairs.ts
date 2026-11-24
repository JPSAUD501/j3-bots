// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, PairBotIds, RoomId, TeammatePair } from "@j3-bots/contracts";
import type { TeammateRunPair } from "../presentation/eventLine.ts";
import { firstLine } from "../presentation/roster.ts";
import type { PresentationContext } from "./status.ts";

/** A name a line draws apart from the words around it: a bot's or a room's. */
export type LineName =
  | { readonly _tag: "bot"; readonly botId: BotId; readonly name: string }
  | { readonly _tag: "room"; readonly roomId: RoomId; readonly name: string };

/** A sentence with its names drawn apart: `parts` to draw, `text` to read aloud. */
export interface NamedLine {
  readonly parts: ReadonlyArray<string | LineName>;
  readonly text: string;
}

const botName = (id: BotId, ctx: PresentationContext) =>
  ctx.botName(id) ?? ctx.i18n.t("bot.unknown");

const botPart = (botId: BotId, ctx: PresentationContext): LineName => ({
  _tag: "bot",
  botId,
  name: botName(botId, ctx),
});

const named = (parts: ReadonlyArray<string | LineName>): NamedLine => ({
  parts,
  text: parts.map((part) => (typeof part === "string" ? part : part.name)).join(""),
});

/** A teammate conversation's title: its two bots' names, in alphabetical order ("Scout and Wren"). */
export function pairTitle(botIds: PairBotIds, ctx: PresentationContext): string {
  const names = botIds
    .map((id) => botName(id, ctx))
    .toSorted((a, b) => a.localeCompare(b, ctx.i18n.locale));
  return new Intl.ListFormat(ctx.i18n.locale, { type: "conjunction" }).format(names);
}

/** A pair's roster and details line: its latest message, after who wrote it ("Wren: …"). */
export function pairLine(pair: TeammatePair, ctx: PresentationContext): string {
  return ctx.i18n.t("summary.fromBot", {
    name: botName(pair.lastMessage.from, ctx),
    text: firstLine(pair.lastMessage.text),
  });
}

/** A row of the chooser a run with several teammates opens: the teammate and how many messages. */
export function teammateChoice(
  pair: TeammateRunPair,
  ctx: PresentationContext,
): { readonly name: string; readonly detail: string } {
  return {
    name: botName(pair.peer, ctx),
    detail: ctx.i18n.plural("pairs.messageCount", pair.count),
  };
}

/**
 * A notice a bot leaves when it builds a team: it started a room
 * (`room-started`, in the room and in its own conversation), or it made this
 * bot for one (`made-for-room`, in the made bot's conversation).
 */
export interface TeamNotice {
  readonly _tag: "room-started" | "made-for-room";
  readonly botId: BotId;
  readonly roomId: RoomId;
}

export interface TeamLineContext extends PresentationContext {
  /** A room's name, or null if it no longer exists. */
  readonly roomName: (id: RoomId) => string | null;
}

/**
 * A team notice as its line says it: "Scout started Support", "Made by Scout
 * for Support", with the bot's and the room's names drawn apart. A room
 * deleted since is "a room".
 */
export function teamNoticeLine(notice: TeamNotice, ctx: TeamLineContext): NamedLine {
  const { i18n } = ctx;
  const bot = botPart(notice.botId, ctx);
  const roomName = ctx.roomName(notice.roomId);
  const started = notice._tag === "room-started";
  if (roomName === null)
    return named(
      i18n.parts(started ? "teamLine.roomStartedGone" : "teamLine.madeForRoomGone", { bot }),
    );
  const room: LineName = { _tag: "room", roomId: notice.roomId, name: roomName };
  return named(
    i18n.parts(started ? "teamLine.roomStarted" : "teamLine.madeForRoom", { bot, room }),
  );
}
