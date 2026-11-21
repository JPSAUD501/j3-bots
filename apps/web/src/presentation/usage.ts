// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecentTurns } from "@j3-bots/client-runtime";
import type {
  Bot,
  BotId,
  ProviderId,
  ProviderStatus,
  UsageTurn,
  UsageWindow,
} from "@j3-bots/contracts";
import type * as DateTime from "effect/DateTime";

/** The turns of one routine, or of every routine deleted since (`name` null). */
interface RoutineSpend {
  readonly key: string;
  readonly name: string | null;
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

/** A provider in the usage view: its limit windows and who spent its turns. */
export interface ProviderUsage {
  readonly id: ProviderId;
  readonly name: string;
  readonly windows: ReadonlyArray<UsageWindow>;
  /** Most turns first; a tie goes to the bot whose turn is the more recent. */
  readonly bots: ReadonlyArray<BotSpend>;
}

const DELETED_ROUTINES = "deleted";

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
  const spent = new Map<
    BotId,
    { readonly botId: BotId; turns: number; routines: Map<string, RoutineSpend> }
  >();
  for (const turn of turns) {
    const bot = spent.get(turn.botId) ?? { botId: turn.botId, turns: 0, routines: new Map() };
    spent.set(turn.botId, bot);
    bot.turns += 1;
    if (turn.routine === null) continue;
    const key = turn.routine._tag === "routine" ? turn.routine.id : DELETED_ROUTINES;
    const name = turn.routine._tag === "routine" ? turn.routine.name : null;
    const routine = bot.routines.get(key);
    bot.routines.set(key, { key, name, turns: (routine?.turns ?? 0) + 1 });
  }
  return byMost(spent.values()).map((bot) => ({
    botId: bot.botId,
    bot: bots.get(bot.botId) ?? null,
    turns: bot.turns,
    routines: byMost(bot.routines.values()),
  }));
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
        windows: provider.usage,
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

/** What the counts cover: the whole period, or its turns since a moment. */
export type Counted =
  | { readonly _tag: "period" }
  | { readonly _tag: "since"; readonly at: DateTime.Utc };

/**
 * What the counts cover: the whole period when every turn in it is read,
 * else the turns since the start of the oldest one read.
 */
export function counted(recent: RecentTurns): Counted {
  const oldest = recent.turns.at(-1);
  return recent.hasMore && oldest !== undefined
    ? { _tag: "since", at: oldest.startedAt }
    : { _tag: "period" };
}
