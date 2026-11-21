// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  BotId,
  Entry,
  EntryPreview,
  FailureClass,
  Room,
  RosterItem,
  RosterItemKey,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { millisBetween, shortDuration, timeInSentence, type TimeContext } from "../lib/time";

export interface PresentationContext extends TimeContext {
  /** A bot's display name, or null if it no longer exists. */
  readonly botName: (id: BotId) => string | null;
}

/**
 * How a line of status is drawn. `default` is what a bot is doing or last
 * said; `secondary` a standing fact, such as its title or a room's members;
 * `empty` stands in for a value that is absent. Waiting and blocked are
 * always worded too.
 */
export type LineTone = "default" | "secondary" | "empty" | "waiting" | "blocked";

export interface StatusLine {
  readonly text: string;
  readonly tone: LineTone;
}

const firstLine = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * A reached usage limit, with when it resets when that is known: one sentence
 * for a bot, its conversation and the provider list, with the day whenever the
 * reset is not today.
 */
export function usageLimitText(resetsAt: DateTime.Utc | null, ctx: TimeContext): string {
  const { t } = ctx.i18n;
  return resetsAt === null
    ? t("failure.usageLimit")
    : t("failure.usageLimitUntil", { when: timeInSentence(resetsAt, ctx) });
}

/**
 * The same limit in a roster row, where the line is cut short: the reset time
 * leads, "Limit resets at 4:15 PM", so it survives the cut.
 */
function rosterUsageLimitText(resetsAt: DateTime.Utc | null, ctx: TimeContext): string {
  const { t } = ctx.i18n;
  return resetsAt === null
    ? t("failure.usageLimit")
    : t("roster.usageLimitUntil", { when: timeInSentence(resetsAt, ctx) });
}

function failureText(
  failure: FailureClass,
  retryAt: DateTime.Utc | null,
  ctx: PresentationContext,
): string {
  const { t } = ctx.i18n;
  switch (failure) {
    case "usage-limit":
      return usageLimitText(retryAt, ctx);
    case "provider-error":
      return t("failure.providerError");
    case "permission-error":
      return t("failure.permissionError");
    case "engine-unavailable":
      return t("failure.engineUnavailable");
    case "session-lost":
      return t("failure.sessionLost");
    case "stopped":
      return t("failure.stopped");
    case "unknown":
      return t("failure.unknown");
  }
}

/**
 * The latest entry in one line, as a roster row says it. `current` is true
 * while the bot waits on that very entry, so a card it still needs reads in
 * the present tense. `owner` is the bot whose conversation it is, `null` in
 * a room: a teammate message in its conversation from another bot is one it
 * received.
 */
function previewSummary(
  preview: EntryPreview,
  ctx: PresentationContext,
  { owner, current }: { readonly owner: BotId | null; readonly current: boolean },
): string {
  const inRoom = owner === null;
  const { t } = ctx.i18n;
  const text = firstLine(preview.text);
  switch (preview.kind) {
    case "message": {
      const said = text || t("summary.files");
      if (preview.author._tag === "operator") return t("summary.fromYou", { text: said });
      if (preview.author._tag === "bot" && inRoom) {
        const name = ctx.botName(preview.author.botId) ?? t("bot.unknown");
        return t("summary.fromBot", { name, text: said });
      }
      return said;
    }
    case "question":
      return t(current ? "summary.asks" : "summary.asked", { prompt: text });
    case "approval":
      return t(current ? "summary.needsApproval" : "summary.askedApproval", { action: text });
    case "secret-request":
      return t(current ? "summary.needsSecret" : "summary.askedSecret", { label: text });
    case "work-fold":
      return t("summary.workFold");
    case "notice":
      return t("summary.notice");
    case "handoff": {
      const nameOf = (id: BotId | null) =>
        (id === null ? null : ctx.botName(id)) ?? t("bot.unknown");
      return preview.author._tag === "bot" && preview.author.botId !== owner
        ? t("summary.handoffFrom", { name: nameOf(preview.author.botId), text })
        : t("summary.handoffTo", { name: nameOf(preview.recipientId), text });
    }
    case "routine-change":
      return text === "" ? t("summary.routineChanged") : t("summary.routine", { name: text });
  }
}

export function workFoldTitle(
  ending: "completed" | "interrupted" | "failed",
  durationMs: number,
  ctx: PresentationContext,
): string {
  const duration = shortDuration(durationMs, ctx.i18n);
  const { t } = ctx.i18n;
  switch (ending) {
    case "completed":
      return t("work.workedFor", { duration });
    case "interrupted":
      return t("work.stoppedAfter", { duration });
    case "failed":
      return t("work.failedAfter", { duration });
  }
}

export function noticeText(
  notice: Extract<Entry, { _tag: "notice" }>["notice"],
  ctx: PresentationContext,
): string {
  const { t } = ctx.i18n;
  switch (notice._tag) {
    case "chain-stopped":
      return notice.limit === "hops" ? t("notice.chainHops") : t("notice.chainFanOut");
    case "turn-failed":
      return failureText(notice.failure, null, ctx);
    case "handoff-failed": {
      const nameOf = (id: BotId) => ctx.botName(id) ?? t("bot.unknown");
      const [first, ...rest] = notice.senders;
      return rest.length === 0
        ? t("notice.handoffFailed", { name: nameOf(first) })
        : t("notice.handoffsFailed", {
            names: new Intl.ListFormat(ctx.i18n.locale, { type: "conjunction" }).format(
              notice.senders.map(nameOf),
            ),
          });
    }
    case "undelivered":
      return t("notice.undelivered");
    case "waiting-in-conversation":
      return t("notice.waitingInConversation", {
        name: ctx.botName(notice.botId) ?? t("bot.unknown"),
      });
    case "session-lost":
      return t("notice.sessionLost");
    case "settings-held":
      return t("notice.settingsHeld");
    case "observation-failed":
      return t("notice.observationFailed");
    case "too-long":
      return t("notice.tooLong");
    case "routine-paused":
      return t("notice.routinePaused", { name: notice.name });
  }
}

/** A turn the server reports as stalled: how long it has been quiet. */
function stalledLine(since: DateTime.Utc, ctx: PresentationContext): StatusLine {
  const duration = shortDuration(millisBetween(since, ctx.now), ctx.i18n);
  return { text: ctx.i18n.t("presence.stalled", { duration }), tone: "waiting" };
}

/**
 * The one line a roster row shows: what the bot needs, or what it is doing, or
 * the last thing said. A room shows its last entry with the speaker's name.
 */
export function rosterLine(item: RosterItem, ctx: PresentationContext): StatusLine {
  const { t } = ctx.i18n;
  const { lastEntry } = item;
  if (item._tag === "bot") {
    const { state } = item.bot;
    switch (state._tag) {
      case "waiting":
        return {
          text:
            lastEntry?.entryId === state.entryId
              ? previewSummary(lastEntry, ctx, { owner: item.bot.id, current: true })
              : t("roster.needsYou"),
          tone: "waiting",
        };
      case "blocked":
        return {
          text:
            state.failure === "usage-limit"
              ? rosterUsageLimitText(state.retryAt, ctx)
              : failureText(state.failure, state.retryAt, ctx),
          tone: "blocked",
        };
      case "thinking":
        return state.stalled
          ? stalledLine(state.since, ctx)
          : { text: t("presence.thinking"), tone: "default" };
      case "working":
        return state.stalled
          ? stalledLine(state.since, ctx)
          : { text: state.activity ?? t("presence.working"), tone: "default" };
      case "idle":
        break;
    }
  }
  return lastEntry
    ? {
        text: previewSummary(lastEntry, ctx, {
          owner: item._tag === "bot" ? item.bot.id : null,
          current: false,
        }),
        tone: "default",
      }
    : { text: t("roster.noMessages"), tone: "empty" };
}

/** The line under a bot's name in its conversation: what it is doing now. */
export function presenceLine(bot: Bot, ctx: PresentationContext): StatusLine | null {
  const { t } = ctx.i18n;
  const { state } = bot;
  switch (state._tag) {
    case "thinking":
      return state.stalled
        ? stalledLine(state.since, ctx)
        : { text: t("presence.thinking"), tone: "default" };
    case "working":
      return state.stalled
        ? stalledLine(state.since, ctx)
        : { text: state.activity ?? t("presence.working"), tone: "default" };
    case "waiting":
      return { text: t("presence.waiting"), tone: "waiting" };
    case "blocked":
      return { text: failureText(state.failure, state.retryAt, ctx), tone: "blocked" };
    case "idle":
      return bot.profile.title === "" ? null : { text: bot.profile.title, tone: "secondary" };
  }
}

/**
 * Whether the operator can stop the bot: a turn runs, or background work holds
 * a change of its settings, which stopping applies.
 */
export const canStop = (bot: Bot): boolean =>
  bot.state._tag === "thinking" || bot.state._tag === "working" || bot.settingsHeld;

/** A room's members by name, as one list in the reader's language. */
export function memberList(room: Room, ctx: PresentationContext): string {
  const names = room.members.map((id) => ctx.botName(id) ?? ctx.i18n.t("bot.unknown"));
  return new Intl.ListFormat(ctx.i18n.locale, { type: "conjunction" }).format(names);
}

/** Which bot or room a roster item is. */
export const rosterKeyOf = (item: RosterItem): RosterItemKey =>
  item._tag === "bot"
    ? { _tag: "bot", botId: item.bot.id }
    : { _tag: "room", roomId: item.room.id };

/**
 * A bot or room as one string: what a roster row is marked with, and what the
 * shell keeps a conversation's draft and timeline under.
 */
export const rosterKeyText = (key: RosterItemKey): string =>
  key._tag === "bot" ? `bot:${key.botId}` : `room:${key.roomId}`;

/** A pending question or approval, or a result not yet read. */
export function needsOperator(item: RosterItem): boolean {
  return item.unread || (item._tag === "bot" && item.bot.state._tag === "waiting");
}

const isPinned = (item: RosterItem) => (item._tag === "bot" ? item.bot.pinned : item.room.pinned);

/** Pinned rows first, then rows that need the operator, then the most recently active. */
export function orderRoster(items: ReadonlyArray<RosterItem>): RosterItem[] {
  const recency = (item: RosterItem) =>
    item.lastActivityAt === null ? -Infinity : DateTime.toEpochMillis(item.lastActivityAt);
  return items
    .map((item) => ({
      item,
      pinned: isPinned(item),
      needs: needsOperator(item),
      at: recency(item),
    }))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || Number(b.needs) - Number(a.needs) || b.at - a.at,
    )
    .map(({ item }) => item);
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The rows to show for a search. Without a query, hidden bots stay out of the
 * roster; a query finds them too.
 */
export function filterRoster(items: ReadonlyArray<RosterItem>, query: string): RosterItem[] {
  const q = fold(query.trim());
  if (q === "") return items.filter((item) => item._tag !== "bot" || !item.bot.hidden);
  return items.filter((item) => {
    const names =
      item._tag === "bot" ? [item.bot.profile.name, item.bot.profile.title] : [item.room.name];
    return names.some((n) => fold(n).includes(q));
  });
}
