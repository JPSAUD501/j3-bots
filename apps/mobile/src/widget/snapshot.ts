// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Loaded } from "@j3-bots/client-runtime";
import { type AvatarState, avatarMood } from "@j3-bots/client-runtime/presentation";
import type { I18n } from "@j3-bots/i18n";
import type { Avatar, BotId, Routine, RoutineRun, RosterItem } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import type { AppLink } from "../links.ts";
import type { WidgetTarget } from "./native.ts";

// What the home-screen widgets show, as the app hands it to Android
// (modules/home-widget, WidgetStore.kt), built from what the app knows. Only
// the bots and routines a widget shows are in it.

/** The light a widget names a bot by: what the operator would want to know at a glance. */
type WidgetLight = "working" | "waiting" | "quiet";

const widgetLight = (state: AvatarState): WidgetLight => {
  switch (state) {
    case "thinking":
    case "working":
    case "speaking":
      return "working";
    case "waiting":
    case "blocked":
      return "waiting";
    case "idle":
    case "unread":
    case "offline":
      return "quiet";
  }
};

type Gone = { readonly gone: true };
const GONE: Gone = { gone: true };

type WidgetBot =
  | Gone
  | {
      readonly gone: false;
      readonly name: string;
      readonly light: WidgetLight;
      /** When the app learned it, in epoch ms: a widget lets "working" go after a while. */
      readonly learnedAt: number;
      readonly link: string;
    };

type WidgetRoutine =
  | Gone
  | {
      readonly gone: false;
      readonly name: string;
      /** When its last run started, in epoch ms; null when it never ran. */
      readonly lastRunAt: number | null;
      readonly running: boolean;
      /** The start of what its last run said, in plain words; empty when there is nothing to say. */
      readonly result: string;
      /** Its result: the conversation for a run that reported back, its runs for any other. */
      readonly link: string;
    };

/** The words a widget says, in the app's language. */
export interface WidgetWords {
  readonly working: string;
  readonly waiting: string;
  readonly quiet: string;
  readonly ran: string;
  readonly running: string;
  readonly neverRan: string;
  readonly botGone: string;
  readonly routineGone: string;
  readonly pickAnother: string;
  readonly notPaired: string;
  readonly openApp: string;
  readonly notYet: string;
  readonly notSetUp: string;
}

export interface WidgetSnapshot {
  readonly language: string;
  readonly paired: boolean;
  readonly words: WidgetWords;
  readonly bots: Readonly<Record<string, WidgetBot>>;
  readonly routines: Readonly<Record<string, WidgetRoutine>>;
}

export const widgetWords = ({ t }: I18n): WidgetWords => ({
  working: t("widget.light.working"),
  waiting: t("widget.light.waiting"),
  quiet: t("widget.light.quiet"),
  ran: t("widget.ran", { when: "{when}" }),
  running: t("widget.running"),
  neverRan: t("widget.neverRan"),
  botGone: t("widget.botGone"),
  routineGone: t("widget.routineGone"),
  pickAnother: t("widget.pickAnother"),
  notPaired: t("widget.notPaired"),
  openApp: t("share.openApp"),
  notYet: t("widget.notYet"),
  notSetUp: t("widget.notSetUp"),
});

/** How much of a routine's result a widget is given: more than its largest size shows. */
export const RESULT_LENGTH = 280;

/** The start of `text` on one line of plain words, at most `RESULT_LENGTH` characters. */
export const resultStart = (text: string): string => {
  const flat = text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return flat.length <= RESULT_LENGTH ? flat : `${flat.slice(0, RESULT_LENGTH - 1).trimEnd()}…`;
};

/** What the app knows that the widgets show, as it builds their snapshot. */
export interface WidgetFacts {
  readonly roster: ReadonlyArray<RosterItem>;
  /** Each routine target's bot's routines, by bot id. */
  readonly routines: ReadonlyMap<BotId, Loaded<ReadonlyArray<Routine>>>;
  /** The text of the messages routines delivered, by entry id, where the app could read it. */
  readonly results: ReadonlyMap<string, string>;
  /** A run that did not report back, or whose message could not be read, in words. */
  readonly runText: (run: RoutineRun) => string;
  readonly link: (link: AppLink) => string;
  readonly now: number;
}

type BotItem = Extract<RosterItem, { _tag: "bot" }>;

const botItem = (roster: ReadonlyArray<RosterItem>, botId: BotId): BotItem | undefined =>
  roster.find((item): item is BotItem => item._tag === "bot" && item.bot.id === botId);

const botState = (item: BotItem): AvatarState =>
  avatarMood(item.bot.state, { unread: item.unread, speaking: false, offline: false }).state;

/** A bot a widget shows: its look and its state now, to draw its face in. */
export interface WidgetFace {
  readonly botId: BotId;
  readonly avatar: Avatar;
  readonly state: AvatarState;
}

/** The faces the bot widgets show, one per bot. */
export const widgetFaces = (
  targets: ReadonlyArray<WidgetTarget>,
  roster: ReadonlyArray<RosterItem>,
): ReadonlyArray<WidgetFace> =>
  [...new Set(targets.filter((target) => target.kind === "bot").map((target) => target.botId))]
    .map((botId) => botItem(roster, botId))
    .filter((item): item is BotItem => item !== undefined && item._tag === "bot")
    .map((item) => ({
      botId: item.bot.id,
      avatar: item.bot.profile.avatar,
      state: botState(item),
    }));

const routineEntry = (routine: Routine, facts: WidgetFacts): WidgetRoutine => {
  const run = routine.lastRun;
  const delivered = run?.status === "delivered" ? (run.delivered[0] ?? null) : null;
  const said = delivered === null ? undefined : facts.results.get(delivered);
  return {
    gone: false,
    name: routine.name,
    lastRunAt: run === null ? null : DateTime.toEpochMillis(run.startedAt),
    running: run?.status === "running",
    result:
      run === null || run.status === "running"
        ? ""
        : resultStart(
            said ?? (run.status === "silent" && run.note !== null ? run.note : facts.runText(run)),
          ),
    link: facts.link(
      delivered === null
        ? { _tag: "routine", botId: routine.botId, routineId: routine.id }
        : { _tag: "bot", botId: routine.botId },
    ),
  };
};

/**
 * The snapshot of `targets`, or null while something one of them shows is
 * still loading: a widget keeps what it showed rather than say less.
 */
export const widgetSnapshot = (
  targets: ReadonlyArray<WidgetTarget>,
  facts: WidgetFacts,
  base: { readonly language: string; readonly words: WidgetWords },
): WidgetSnapshot | null => {
  const bots: Record<string, WidgetBot> = {};
  const routines: Record<string, WidgetRoutine> = {};
  for (const target of targets) {
    const item = botItem(facts.roster, target.botId);
    if (target.kind === "bot") {
      bots[target.botId] =
        item === undefined
          ? GONE
          : {
              gone: false,
              name: item.bot.profile.name,
              light: widgetLight(botState(item)),
              learnedAt: facts.now,
              link: facts.link({ _tag: "bot", botId: item.bot.id }),
            };
      continue;
    }
    if (item === undefined) {
      routines[target.routineId] = GONE;
      continue;
    }
    const loaded = facts.routines.get(target.botId);
    if (loaded === undefined || loaded._tag === "loading") return null;
    const routine =
      loaded._tag === "ready"
        ? loaded.value.find((candidate) => candidate.id === target.routineId)
        : undefined;
    routines[target.routineId] = routine === undefined ? GONE : routineEntry(routine, facts);
  }
  return { ...base, paired: true, bots, routines };
};

/** What the widgets show on a phone that is not paired: that it is not, whatever they were set up for. */
export const unpairedSnapshot = (base: {
  readonly language: string;
  readonly words: WidgetWords;
}): WidgetSnapshot => ({ ...base, paired: false, bots: {}, routines: {} });

/** How long the app's word that a bot works stands, in ms: a widget lets it go after. */
export const WORKING_HOLDS = 30 * 60 * 1000;

/**
 * What tells one write to the widgets from another: all a snapshot shows,
 * and the faces it is drawn with. When the app learned a bot's state is no
 * news, except for a bot at work, which a widget shows as quiet once that is
 * `WORKING_HOLDS` old: it is news again every third of that.
 */
export const snapshotKey = (snapshot: WidgetSnapshot, faces: ReadonlyArray<WidgetFace>): string =>
  JSON.stringify({
    ...snapshot,
    bots: Object.fromEntries(
      Object.entries(snapshot.bots).map(([id, bot]) => [
        id,
        bot.gone
          ? bot
          : {
              ...bot,
              learnedAt:
                bot.light === "working" ? Math.floor(bot.learnedAt / (WORKING_HOLDS / 3)) : 0,
            },
      ]),
    ),
    faces,
  });
