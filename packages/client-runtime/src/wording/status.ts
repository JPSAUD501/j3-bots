// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Bot,
  type BotId,
  type Entry,
  type EntryPreview,
  entryText,
  foldEnding,
  type FailureClass,
  type MessageEntry,
  type Room,
  type RoomId,
  type RosterItem,
} from "@j3-bots/contracts";
import type * as DateTime from "effect/DateTime";
import type { OpeningHold } from "../presentation/engine.ts";
import { firstLine } from "../presentation/roster.ts";
import { millisBetween, shortDuration } from "../presentation/time.ts";
import { permissionModeText } from "./details.ts";
import { teamNoticeLine } from "./pairs.ts";
import { timeInSentence, type TimeContext } from "./time.ts";
import { activityText, workDoneText } from "./work.ts";

export interface PresentationContext extends TimeContext {
  /** A bot's display name, or null if it no longer exists. */
  readonly botName: (id: BotId) => string | null;
  /** A room's name as it is now, archived or not, or null if it no longer exists. */
  readonly roomName: (id: RoomId) => string | null;
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
  preview: Pick<
    EntryPreview,
    "kind" | "author" | "text" | "recipientId" | "step" | "ending" | "notice"
  >,
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
    case "browser-help":
      return t(current ? "summary.needsBrowserHelp" : "summary.askedBrowserHelp", { note: text });
    case "secret-ask":
      return t(current ? "summary.needsSecretAsk" : "summary.askedSecretAsk", { name: text });
    case "connector-auth":
      return t("summary.connectorSignIn", { name: text });
    case "connector-input":
      return t(current ? "summary.connectorAsks" : "summary.connectorAsked", { name: text });
    case "work-fold":
      return workDoneText(preview.step, preview.ending, ctx.i18n);
    case "notice":
      if (preview.notice === null) return t("summary.notice");
      return preview.notice._tag === "unknown"
        ? t("summary.cannotShow")
        : noticeText(preview.notice, ctx);
    case "handoff": {
      const nameOf = (id: BotId | null) =>
        (id === null ? null : ctx.botName(id)) ?? t("bot.unknown");
      return preview.author._tag === "bot" && preview.author.botId !== owner
        ? t("summary.handoffFrom", { name: nameOf(preview.author.botId), text })
        : t("summary.handoffTo", { name: nameOf(preview.recipientId), text });
    }
    case "routine-change":
      return text === "" ? t("summary.routineChanged") : t("summary.routine", { name: text });
    case "unknown":
      return t("summary.cannotShow");
  }
}

export function noticeText(
  notice: Extract<Entry, { _tag: "notice" }>["notice"],
  ctx: PresentationContext,
): string {
  const { t } = ctx.i18n;
  switch (notice._tag) {
    case "chain-stopped":
      switch (notice.limit) {
        case "hops":
          return t("notice.chainHops");
        case "fan-out":
          return t("notice.chainFanOut");
        case "room":
          return t("notice.chainRoom");
      }
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
    case "session-not-ready":
      return t("notice.sessionNotReady");
    case "permission-mode-refused": {
      const mode = permissionModeText(notice.permissionMode, ctx.i18n).name;
      return notice.allowed === null
        ? t("notice.permissionModeRefused", { mode })
        : t("notice.permissionModeAllowed", {
            mode,
            allowed: permissionModeText(notice.allowed, ctx.i18n).name,
          });
    }
    case "member-mode-refused":
      return t("notice.memberModeRefused", {
        name: ctx.botName(notice.botId) ?? t("bot.unknown"),
      });
    case "settings-held":
      return t("notice.settingsHeld");
    case "observation-failed":
      return t("notice.observationFailed");
    case "too-long":
      return t("notice.tooLong");
    case "routine-paused":
      return t("notice.routinePaused", { name: notice.name });
    case "operator-named":
      return t("notice.operatorNamed", {
        bot: ctx.botName(notice.botId) ?? t("bot.unknown"),
        name: notice.name,
      });
    case "room-started":
    case "made-for-room":
      return teamNoticeLine(notice, ctx).text;
  }
}

/**
 * A turn the server reports as stalled: how long it has been quiet, from its
 * last activity, or only that it has been when the server does not say.
 */
function stalledLine(quietSince: DateTime.Utc | null, ctx: PresentationContext): StatusLine {
  if (quietSince === null) return { text: ctx.i18n.t("presence.stalledQuiet"), tone: "waiting" };
  const duration = shortDuration(millisBetween(quietSince, ctx.now), ctx.i18n);
  return { text: ctx.i18n.t("presence.stalled", { duration }), tone: "waiting" };
}

/**
 * A card in one line, as the roster says it: "Asks: …" while the bot waits on
 * it, "Asked: …" once it does not. `owner` is the bot whose conversation it
 * is, `null` in a room.
 */
export function entrySummary(
  entry: Exclude<Entry, MessageEntry>,
  ctx: PresentationContext,
  { owner, current }: { readonly owner: BotId | null; readonly current: boolean },
): string {
  return previewSummary(
    {
      kind: entry._tag,
      author: entry.author,
      text: entryText(entry),
      recipientId: entry._tag === "handoff" ? entry.recipientId : null,
      step: null,
      ending: foldEnding(entry),
      notice: entry._tag === "notice" ? entry.notice : null,
    },
    ctx,
    { owner, current },
  );
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
          ? stalledLine(state.quietSince, ctx)
          : { text: t("presence.thinking"), tone: "default" };
      case "working":
        return state.stalled
          ? stalledLine(state.quietSince, ctx)
          : { text: activityText(state.activity, state.tool, ctx.i18n), tone: "default" };
      case "idle":
        if (lastEntry === null && item.bot.opening) {
          return { text: t("roster.gettingReady"), tone: "default" };
        }
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

/**
 * Whether a bot whose conversation is empty is about to speak first: a turn
 * runs, or it is idle with its opening still to come. A new bot's state
 * passes through idle while its first turn is set up, so the state alone
 * would say "nothing yet" and then "getting ready" again. A blocked bot is
 * not getting ready, whatever its opening: it waits on what blocks it.
 */
const speaksFirst = (bot: Bot) =>
  bot.state._tag === "thinking" ||
  bot.state._tag === "working" ||
  (bot.state._tag === "idle" && bot.opening);

/** What a bot's conversation says before anything is said in it. */
export function quietConversationText(bot: Bot, ctx: PresentationContext): string {
  const name = bot.profile.name;
  return speaksFirst(bot)
    ? ctx.i18n.t("empty.quiet.speaksFirst", { name })
    : ctx.i18n.t("empty.quiet.body", { name });
}

/** A quiet conversation's line while the bot's hello waits (`openingHeld`). */
export function heldHelloText(name: string, hold: OpeningHold, ctx: TimeContext): string {
  const { t } = ctx.i18n;
  if (hold._tag !== "limit") return t("empty.quiet.waitingForModel", { name });
  return hold.resetsAt === null
    ? t("empty.quiet.waitingForReset", { name })
    : t("empty.quiet.waitingForResetAt", { name, when: timeInSentence(hold.resetsAt, ctx) });
}

/**
 * What a bot is doing now, in one line: the line of its turn under way, and
 * what its conversation says aloud as that changes. A bot at rest is doing
 * nothing: null.
 */
export function presenceLine(bot: Bot, ctx: PresentationContext): StatusLine | null {
  const { t } = ctx.i18n;
  const { state } = bot;
  switch (state._tag) {
    case "thinking":
      return state.stalled
        ? stalledLine(state.quietSince, ctx)
        : { text: t("presence.thinking"), tone: "default" };
    case "working":
      return state.stalled
        ? stalledLine(state.quietSince, ctx)
        : { text: activityText(state.activity, state.tool, ctx.i18n), tone: "default" };
    case "waiting":
      return { text: t("presence.waiting"), tone: "waiting" };
    case "blocked":
      return { text: failureText(state.failure, state.retryAt, ctx), tone: "blocked" };
    case "idle":
      return null;
  }
}

/** A room's members by name, as one list in the reader's language. */
export function memberList(room: Room, ctx: PresentationContext): string {
  const names = room.members.map((id) => ctx.botName(id) ?? ctx.i18n.t("bot.unknown"));
  return new Intl.ListFormat(ctx.i18n.locale, { type: "conjunction" }).format(names);
}
