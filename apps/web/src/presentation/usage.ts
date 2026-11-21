// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecentTurns } from "@j3-bots/client-runtime";
import type {
  Bot,
  BotId,
  ProviderId,
  ProviderStatus,
  RoutineId,
  UsageRoutine,
  UsageTurn,
  UsageWindow,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { timeInSentence, type TimeContext } from "../lib/time";

/** The turns of one routine, or of every routine deleted since. */
interface RoutineSpend {
  readonly routine: UsageRoutine;
  readonly turns: number;
}

/** The turns one bot spent on a provider, and among them each routine's. */
export interface BotSpend {
  readonly botId: BotId;
  /** Null for a bot that is gone. */
  readonly bot: Bot | null;
  readonly turns: number;
  readonly routines: ReadonlyArray<RoutineSpend>;
}

/** A limit window and a key for it. */
interface KeyedWindow {
  readonly key: string;
  readonly usageWindow: UsageWindow;
}

/** A provider in the usage view: its limit windows and who spent its turns. */
export interface ProviderUsage {
  readonly id: ProviderId;
  readonly name: string;
  /** In the engine's order. */
  readonly windows: ReadonlyArray<KeyedWindow>;
  /** Most turns first; a tie goes to the bot whose turn is the more recent. */
  readonly bots: ReadonlyArray<BotSpend>;
}

/** Counts by key, most first; a tie keeps the order of first appearance. */
const byMost = <A extends { readonly turns: number }>(counts: Iterable<A>): Array<A> =>
  [...counts].sort((a, b) => b.turns - a.turns);

/**
 * The bots that spent `turns`, newest first as the server reads them, most
 * first, with each routine's share. The turns of routines deleted since are
 * one share: nothing tells them apart anymore.
 */
function botSpends(
  turns: ReadonlyArray<UsageTurn>,
  bots: ReadonlyMap<BotId, Bot>,
): ReadonlyArray<BotSpend> {
  interface Spent {
    readonly botId: BotId;
    turns: number;
    /** Each routine's share, and that of the routines deleted since under `null`. */
    readonly routines: Map<RoutineId | null, RoutineSpend>;
  }
  const spent = new Map<BotId, Spent>();
  for (const turn of turns) {
    const bot = spent.get(turn.botId) ?? { botId: turn.botId, turns: 0, routines: new Map() };
    spent.set(turn.botId, bot);
    bot.turns += 1;
    if (turn.routine === null) continue;
    const key = turn.routine._tag === "routine" ? turn.routine.id : null;
    const routine = bot.routines.get(key);
    bot.routines.set(key, { routine: turn.routine, turns: (routine?.turns ?? 0) + 1 });
  }
  return byMost(spent.values()).map((bot) => ({
    botId: bot.botId,
    bot: bots.get(bot.botId) ?? null,
    turns: bot.turns,
    routines: byMost(bot.routines.values()),
  }));
}

/**
 * Each window keyed by its label and how many windows before it share that
 * label: the engine's labels need not be unique.
 */
function keyedWindows(windows: ReadonlyArray<UsageWindow>): ReadonlyArray<KeyedWindow> {
  const seen = new Map<string, number>();
  return windows.map((usageWindow) => {
    const before = seen.get(usageWindow.label) ?? 0;
    seen.set(usageWindow.label, before + 1);
    return { key: `${before}:${usageWindow.label}`, usageWindow };
  });
}

/**
 * The providers the usage view lists, in the engine's order: each that can
 * run bots, reports a limit window or spent some of `turns`. A provider the
 * engine no longer lists but that spent turns comes last, named by its id.
 */
export function providerUsage(
  providers: ReadonlyArray<ProviderStatus>,
  turns: ReadonlyArray<UsageTurn>,
  bots: ReadonlyMap<BotId, Bot>,
): ReadonlyArray<ProviderUsage> {
  const spentOn = (id: ProviderId) => turns.filter((turn) => turn.providerId === id);
  const listed = providers.flatMap((provider): Array<ProviderUsage> => {
    const spent = spentOn(provider.id);
    const runs = provider.status._tag === "ready" || provider.status._tag === "limited";
    if (!runs && provider.usage.length === 0 && spent.length === 0) return [];
    return [
      {
        id: provider.id,
        name: provider.name,
        windows: keyedWindows(provider.usage),
        bots: botSpends(spent, bots),
      },
    ];
  });
  const known = new Set(providers.map((provider) => provider.id));
  const gone = [...new Set(turns.map((turn) => turn.providerId))].filter((id) => !known.has(id));
  return [
    ...listed,
    ...gone.map((id) => ({ id, name: id, windows: [], bots: botSpends(spentOn(id), bots) })),
  ];
}

/** What the counts cover. */
export type Coverage =
  /** Every turn of the period. */
  | { readonly _tag: "period" }
  /**
   * The latest `count` turns of the period, the oldest started at `oldest`;
   * the period holds earlier ones. `capped` when no read takes more.
   */
  | {
      readonly _tag: "latest";
      readonly count: number;
      readonly oldest: DateTime.Utc;
      readonly capped: boolean;
    };

/** What the counts of `recent` cover. */
export function coverage(recent: RecentTurns): Coverage {
  const oldest = recent.turns.at(-1);
  return recent.hasMore && oldest !== undefined
    ? {
        _tag: "latest",
        count: recent.turns.length,
        oldest: oldest.startedAt,
        capped: !recent.canLoadMore,
      }
    : { _tag: "period" };
}

/** A limit window in words, as of `ctx.now`. */
export interface WindowText {
  readonly name: string;
  /** How much is used, or that the limit is reached. */
  readonly used: string;
  /** Percent used, rounded down, so a window short of its limit never reads as full. */
  readonly percent: number;
  /**
   * `open`: under its limit. `full`: at it, until it resets. `reset`: its
   * reset passed, so `used` is the last figure the engine reported before it.
   */
  readonly tone: "open" | "full" | "reset";
  /** When it resets or reset, when the engine says. */
  readonly reset: string | null;
}

/**
 * One window as the usage view words it. The engine calls its five-hour
 * window "Session", which is not a J3 Bots session, so that one reads as the
 * five-hour window; every other label is the engine's own, such as "Weekly"
 * or "Weekly · Claude Opus 5.5". A window at its limit says only that the
 * window is: a model's window blocks that model, not the provider. A window
 * keeps its last figures until the engine checks again, also past its reset,
 * so then it says when it reset and that new figures come with the next check.
 */
export function windowText(usageWindow: UsageWindow, ctx: TimeContext): WindowText {
  const { t } = ctx.i18n;
  const percent = Math.floor(usageWindow.usedPercent);
  const resetsAt = usageWindow.resetsAt;
  const reset =
    resetsAt !== null && DateTime.toEpochMillis(resetsAt) <= DateTime.toEpochMillis(ctx.now);
  const tone = reset ? "reset" : usageWindow.usedPercent >= 100 ? "full" : "open";
  const formatted = new Intl.NumberFormat(ctx.i18n.locale, { style: "percent" }).format(
    percent / 100,
  );
  return {
    name: usageWindow.label === "Session" ? t("usage.fiveHours") : usageWindow.label,
    used: tone === "full" ? t("usage.full") : t("usage.used", { percent: formatted }),
    percent,
    tone,
    reset:
      resetsAt === null
        ? null
        : t(reset ? "usage.reset" : "usage.resets", { when: timeInSentence(resetsAt, ctx) }),
  };
}
