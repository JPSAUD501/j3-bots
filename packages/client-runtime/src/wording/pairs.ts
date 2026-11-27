// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, Notice, PairBotIds, RoomId, TeammatePair } from "@j3-bots/contracts";
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

/**
 * A teammate conversation's two bots in the order its title names them: by
 * name, in the operator's language. Its avatars and menu follow the same order.
 */
export function pairOrder(botIds: PairBotIds, ctx: PresentationContext): readonly [BotId, BotId] {
  const [a, b] = botIds;
  return botName(a, ctx).localeCompare(botName(b, ctx), ctx.i18n.locale) <= 0 ? [a, b] : [b, a];
}

/** A teammate conversation's title: its two bots' names, in alphabetical order ("Scout and Wren"). */
export function pairTitle(botIds: PairBotIds, ctx: PresentationContext): string {
  return new Intl.ListFormat(ctx.i18n.locale, { type: "conjunction" }).format(
    pairOrder(botIds, ctx).map((id) => botName(id, ctx)),
  );
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
 * bot for one (`made-for-room`, in the made bot's conversation); or a room of
 * bots only it started paused (`room-paused`, in the room and in its own
 * conversation).
 */
export type TeamNotice = Extract<
  Notice,
  { readonly _tag: "room-started" | "made-for-room" | "room-paused" }
>;

const TEAM_LINES = {
  "room-started": { here: "teamLine.roomStarted", gone: "teamLine.roomStartedGone" },
  "made-for-room": { here: "teamLine.madeForRoom", gone: "teamLine.madeForRoomGone" },
  "room-paused": { here: "teamLine.roomPaused", gone: "teamLine.roomPausedGone" },
} as const;

/**
 * A team notice as its line says it: "Scout started Support", "Made by Scout
 * for Support", "Support paused: …, and Scout was told", with the bot's and
 * the room's names drawn apart. The room is named as it is now, so a rename
 * shows; a room deleted since is "a room".
 */
export function teamNoticeLine(notice: TeamNotice, ctx: PresentationContext): NamedLine {
  const { i18n } = ctx;
  const bot = botPart(notice.botId, ctx);
  const roomName = ctx.roomName(notice.roomId);
  const keys = TEAM_LINES[notice._tag];
  if (roomName === null) return named(i18n.parts(keys.gone, { bot }));
  const room: LineName = { _tag: "room", roomId: notice.roomId, name: roomName };
  return named(i18n.parts(keys.here, { bot, room }));
}
