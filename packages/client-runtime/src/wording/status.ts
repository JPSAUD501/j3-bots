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
  /**
   * What the operator calls the AI the bot thinks with, such as Claude
   * (`aiNameOf`), or null when that is not known.
   */
  readonly aiName: (bot: Bot) => string | null;
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

/**
 * Why a bot's work did not finish, in plain words, with what the operator can
 * do about it. `ai` names the bot's AI when it is known: a notice does not say
 * whose turn it was. The engine's own words stay behind Details
 * (`failureDetails`).
 */
function failureText(
  failure: FailureClass,
  retryAt: DateTime.Utc | null,
  ai: string | null,
  ctx: PresentationContext,
): string {
  const { t } = ctx.i18n;
  switch (failure) {
    case "usage-limit":
      return usageLimitText(retryAt, ctx);
    case "provider-error":
      return ai === null ? t("failure.providerErrorUnnamed") : t("failure.providerError", { ai });
    case "permission-error":
      return ai === null
        ? t("failure.permissionErrorUnnamed")
        : t("failure.permissionError", { ai });
    case "unreachable":
      return ai === null ? t("failure.unreachableUnnamed") : t("failure.unreachable", { ai });
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
    case "connector-ask":
      return t(current ? "summary.needsConnectorYes" : "summary.askedConnectorYes", { name: text });
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
      return failureText(notice.failure, null, null, ctx);
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
    case "asks-before-acting": {
      const mode = permissionModeText(notice.permissionMode, ctx.i18n).name;
      return notice.permissionMode === "auto"
        ? t("notice.asksBeforeActingAuto", { mode })
        : t("notice.asksBeforeActingFullAccess", { mode });
    }
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
              : failureText(state.failure, state.retryAt, ctx.aiName(item.bot), ctx),
          tone: "blocked",
        };
      case "thinking":
      case "working":
        return turnUnderWayLine(item.bot, state, ctx);
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
 * What a bot's turn under way is doing, in one line: typing its next message
 * in a first contact, quiet long enough to look stalled, or the step it is on.
 */
function turnUnderWayLine(
  bot: Bot,
  state: Extract<Bot["state"], { readonly _tag: "thinking" | "working" }>,
  ctx: PresentationContext,
): StatusLine {
  const { t } = ctx.i18n;
  if (state.typing) return { text: t("presence.typing"), tone: "default" };
  // A retry that works leaves no trace: the line goes back to the turn's step.
  if (state.retrying) {
    const ai = ctx.aiName(bot);
    return {
      text: ai === null ? t("presence.retryingUnnamed") : t("presence.retrying", { ai }),
      tone: "waiting",
    };
  }
  if (state.stalled) return stalledLine(state.quietSince, ctx);
  return state._tag === "thinking"
    ? { text: t("presence.thinking"), tone: "default" }
    : { text: activityText(state.activity, state.tool, ctx.i18n), tone: "default" };
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
    case "working":
      return turnUnderWayLine(bot, state, ctx);
    case "waiting":
      return { text: t("presence.waiting"), tone: "waiting" };
    case "blocked":
      return {
        text: failureText(state.failure, state.retryAt, ctx.aiName(bot), ctx),
        tone: "blocked",
      };
    case "idle":
      return null;
  }
}

/** A room's members by name, as one list in the reader's language. */
export function memberList(room: Room, ctx: PresentationContext): string {
  const names = room.members.map((id) => ctx.botName(id) ?? ctx.i18n.t("bot.unknown"));
  return new Intl.ListFormat(ctx.i18n.locale, { type: "conjunction" }).format(names);
}
