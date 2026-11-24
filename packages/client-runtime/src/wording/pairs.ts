// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, HandoffState, PairBotIds, RoomId, TeammatePair } from "@j3-bots/contracts";
import type { I18n, KeyWith } from "@j3-bots/i18n";
import type { TeammateRun, TeammateRunPair } from "../presentation/pairs.ts";
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

const stateKeys = {
  "not-delivered": "handoff.notDelivered",
  stopped: "handoff.stopped",
  unconfirmed: "handoff.unconfirmed",
} as const satisfies Record<Exclude<HandoffState, "sent">, KeyWith>;

/** What a teammate message's mark says, or null for one that went (`sent`). */
export function handoffStateText(state: HandoffState, i18n: I18n): string | null {
  return state === "sent" ? null : i18n.t(stateKeys[state]);
}

/** The bots `ids`, as a list whose names are drawn apart ("Wren and Pip"). */
function nameList(
  ids: ReadonlyArray<BotId>,
  ctx: PresentationContext,
): ReadonlyArray<string | LineName> {
  const names = ids.map((id) => botPart(id, ctx));
  const list = new Intl.ListFormat(ctx.i18n.locale, { type: "conjunction" }).formatToParts(
    names.map((name) => name.name),
  );
  let next = 0;
  return list.map((part) => (part.type === "element" ? (names[next++] ?? part.value) : part.value));
}

type RunKey = "teammates.wrote" | "teammates.heard" | "teammates.heardSeveral" | "teammates.talked";

/** The sentence a run's line says, by what the bot did in it. */
const runKey = (run: TeammateRun): RunKey => {
  switch (run.direction) {
    case "sent":
      return "teammates.wrote";
    case "received":
      return run.pairs.length === 1 ? "teammates.heard" : "teammates.heardSeveral";
    case "both":
      return "teammates.talked";
  }
};

/**
 * A run of teammate messages as its line says it, in the bot's own
 * conversation: "Wrote to Wren", "Wren wrote", "Talked with Wren and Pip · 4
 * messages". `mark` counts the messages that never reached their teammate,
 * in a muted voice, or is null when every one did.
 */
export function teammateRunLine(
  run: TeammateRun,
  ctx: PresentationContext,
): NamedLine & { readonly mark: string | null } {
  const names = nameList(
    run.pairs.map((pair) => pair.peer),
    ctx,
  );
  const sentence = ctx.i18n.pluralParts<RunKey, ReadonlyArray<string | LineName>>(
    runKey(run),
    run.entries.length,
    { names },
  );
  return {
    ...named(sentence.flatMap((part) => (typeof part === "string" ? [part] : part))),
    mark: run.undelivered === 0 ? null : ctx.i18n.plural("teammates.undelivered", run.undelivered),
  };
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
