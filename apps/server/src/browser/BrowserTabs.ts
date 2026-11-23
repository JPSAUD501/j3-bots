// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type BrowserTab,
  BrowserTabRef,
  type BrowserTabs as TabsFrame,
  type DeviceId,
  NotFound,
} from "@j3-bots/contracts";
import {
  BrowserBridge,
  type EngineBrowserTab,
  type EngineTabId,
  SessionId,
} from "@j3-bots/engine-t3";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { BotStore } from "../bots/BotStore.ts";
import { Ids } from "../Ids.ts";

/** A tab a bot has open, as the server knows it. */
interface KnownTab {
  readonly ref: BrowserTabRef;
  readonly botId: BotId;
  readonly tab: EngineBrowserTab;
}

/** A bot's tab that most recently opened or navigated, the one it works in. */
export interface FrontTab {
  readonly ref: BrowserTabRef;
  readonly tab: EngineTabId;
  /** Empty for a tab that has not loaded a page yet. */
  readonly url: string;
}

/** A tab a device holds, taken from the bot that opened it. */
export interface HeldTab {
  readonly tab: EngineTabId;
  readonly botId: BotId;
  readonly deviceId: DeviceId;
}

/**
 * The bots' browser tabs: which bot each belongs to, the ref clients name it
 * by, and which device holds it. One feed of the engine's tabs runs for as
 * long as the server does; a client's `browser.subscribe` reads from it.
 *
 * A ref is minted the first time the server sees a tab and is dropped when the
 * tab closes, so it names nothing after that, nor after a restart.
 */
export class BrowserTabs extends Context.Service<
  BrowserTabs,
  {
    /** The bot's tabs, as `deviceId` sees them, now and on every change. */
    readonly subscribe: (botId: BotId, deviceId: DeviceId) => Stream.Stream<TabsFrame, NotFound>;
    /** The tab a ref names, while it is open. */
    readonly resolve: (ref: BrowserTabRef) => Effect.Effect<Option.Option<EngineTabId>>;
    /**
     * Records whether `deviceId` holds `tab`, as its viewer reports it. Letting
     * go clears the tab only when that device was the one holding it.
     */
    readonly holding: (tab: EngineTabId, deviceId: DeviceId, holds: boolean) => Effect.Effect<void>;
    /** The bot's front tab, while it has a tab open. */
    readonly front: (botId: BotId) => Effect.Effect<Option.Option<FrontTab>>;
    /** The tabs the bot has open now. */
    readonly tabsOf: (botId: BotId) => Effect.Effect<ReadonlyArray<EngineTabId>>;
    /** Every tab open now, then again on every change. */
    readonly open: Stream.Stream<ReadonlySet<EngineTabId>>;
    /** Every tab a device holds now, then again on every change. */
    readonly held: Stream.Stream<ReadonlyArray<HeldTab>>;
  }
>()("@j3-bots/server/browser/BrowserTabs") {}

const decodeSessionIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: SessionId })));

export const layer = Layer.effect(
  BrowserTabs,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bridge = yield* BrowserBridge;
    const ids = yield* Ids;
    const store = yield* BotStore;

    const known = yield* SubscriptionRef.make<ReadonlyArray<KnownTab>>([]);
    const holders = yield* SubscriptionRef.make<ReadonlyMap<EngineTabId, DeviceId>>(new Map());
    const refs = new Map<EngineTabId, BrowserTabRef>();
    const tabsByRef = new Map<BrowserTabRef, EngineTabId>();
    /** Which bot each session belongs to; a session never changes hands. */
    const botOfSession = new Map<SessionId, BotId>();

    /** Every session that may hold tabs: the bots' sessions still in use. */
    const liveSessions = sql`
      SELECT engine_session_id AS id FROM sessions
      WHERE retired_at IS NULL AND engine_session_id IS NOT NULL
    `.pipe(
      Effect.flatMap(decodeSessionIds),
      Effect.map((rows) => rows.map((row) => row.id)),
      Effect.orDie,
    );

    const findBot = SqlSchema.findOneOption({
      Request: SessionId,
      Result: Schema.Struct({ bot_id: BotId }),
      execute: (sessionId) =>
        sql`SELECT bot_id FROM sessions WHERE engine_session_id = ${sessionId}`,
    });

    const botOf = Effect.fnUntraced(function* (sessionId: SessionId) {
      const cached = botOfSession.get(sessionId);
      if (cached !== undefined) return Option.some(cached);
      const row = yield* findBot(sessionId).pipe(Effect.orDie);
      if (Option.isSome(row)) botOfSession.set(sessionId, row.value.bot_id);
      return Option.map(row, (found) => found.bot_id);
    });

    /** The engine's list, with each tab's bot and ref; a tab of no bot's session is left out. */
    const learn = Effect.fnUntraced(function* (tabs: ReadonlyArray<EngineBrowserTab>) {
      const next: Array<KnownTab> = [];
      for (const tab of tabs) {
        const botId = yield* botOf(tab.sessionId);
        if (Option.isNone(botId)) continue;
        let ref = refs.get(tab.id);
        if (ref === undefined) {
          ref = BrowserTabRef.make(yield* ids.make("tab"));
          refs.set(tab.id, ref);
          tabsByRef.set(ref, tab.id);
        }
        next.push({ ref, botId: botId.value, tab });
      }
      const open = new Set(next.map((known) => known.tab.id));
      for (const [id, ref] of refs) {
        if (open.has(id)) continue;
        refs.delete(id);
        tabsByRef.delete(ref);
      }
      yield* SubscriptionRef.set(known, next);
      yield* SubscriptionRef.update(holders, (current) => {
        const kept = new Map([...current].filter(([id]) => open.has(id)));
        return kept.size === current.size ? current : kept;
      });
    });

    yield* bridge.tabs(liveSessions).pipe(Stream.runForEach(learn), Effect.forkScoped);

    const subscribe = (botId: BotId, deviceId: DeviceId): Stream.Stream<TabsFrame, NotFound> =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (Option.isNone(yield* store.find(botId)))
            return yield* new NotFound({ resource: "bot" });
          return Stream.zipLatestWith(
            SubscriptionRef.changes(known),
            SubscriptionRef.changes(holders),
            (all, held): TabsFrame => {
              const mine = all.filter((known) => known.botId === botId);
              const front = frontOf(mine);
              return {
                tabs: mine.map((known): BrowserTab => ({
                  ref: known.ref,
                  botId,
                  url: known.tab.url,
                  title: known.tab.title,
                  loading: known.tab.loading,
                  controller: Option.match(Option.fromUndefinedOr(held.get(known.tab.id)), {
                    onNone: () => "bot",
                    onSome: (holder) => (holder === deviceId ? "you" : "another-device"),
                  }),
                  front: known === front,
                })),
              };
            },
          ).pipe(Stream.changesWith(sameFrame));
        }),
      );

    const resolve = (ref: BrowserTabRef) =>
      Effect.sync(() => Option.fromUndefinedOr(tabsByRef.get(ref)));

    const holding = (tab: EngineTabId, deviceId: DeviceId, holds: boolean) =>
      SubscriptionRef.update(holders, (current) => {
        const holder = current.get(tab);
        if (holds) {
          if (holder === deviceId || !refs.has(tab)) return current;
          return new Map(current).set(tab, deviceId);
        }
        if (holder !== deviceId) return current;
        const next = new Map(current);
        next.delete(tab);
        return next;
      });

    const front = (botId: BotId) =>
      SubscriptionRef.get(known).pipe(
        Effect.map((all) =>
          Option.map(
            Option.fromUndefinedOr(frontOf(all.filter((known) => known.botId === botId))),
            (newest): FrontTab => ({ ref: newest.ref, tab: newest.tab.id, url: newest.tab.url }),
          ),
        ),
      );

    const tabsOf = (botId: BotId) =>
      SubscriptionRef.get(known).pipe(
        Effect.map((all) => all.filter((known) => known.botId === botId).map(({ tab }) => tab.id)),
      );

    const open = SubscriptionRef.changes(known).pipe(
      Stream.map((all): ReadonlySet<EngineTabId> => new Set(all.map(({ tab }) => tab.id))),
    );

    const held = Stream.zipLatestWith(
      SubscriptionRef.changes(known),
      SubscriptionRef.changes(holders),
      (all, byTab): ReadonlyArray<HeldTab> =>
        all.flatMap(({ tab, botId }) => {
          const deviceId = byTab.get(tab.id);
          return deviceId === undefined ? [] : [{ tab: tab.id, botId, deviceId }];
        }),
    ).pipe(Stream.changesWith(sameHeld));

    return BrowserTabs.of({ subscribe, resolve, holding, front, tabsOf, open, held });
  }),
);

/** The tab that most recently opened or navigated, among `tabs`. */
const frontOf = (tabs: ReadonlyArray<KnownTab>): KnownTab | undefined =>
  tabs.reduce<KnownTab | undefined>(
    (newest, known) =>
      newest === undefined || known.tab.activeAt > newest.tab.activeAt ? known : newest,
    undefined,
  );

const sameHeld = (left: ReadonlyArray<HeldTab>, right: ReadonlyArray<HeldTab>) =>
  left.length === right.length &&
  left.every((held, index) => {
    const other = right[index];
    return other !== undefined && held.tab === other.tab && held.deviceId === other.deviceId;
  });

const sameTab = (left: BrowserTab, right: BrowserTab) =>
  left.ref === right.ref &&
  left.url === right.url &&
  left.title === right.title &&
  left.loading === right.loading &&
  left.controller === right.controller &&
  left.front === right.front;

const sameFrame = (left: TabsFrame, right: TabsFrame) =>
  left.tabs.length === right.tabs.length &&
  left.tabs.every((tab, index) => {
    const other = right.tabs[index];
    return other !== undefined && sameTab(tab, other);
  });
