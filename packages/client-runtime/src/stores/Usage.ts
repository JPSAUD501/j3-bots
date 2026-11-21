// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_USAGE_TURNS, type UsageTurn } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { Connection, type J3RpcClient } from "../connection/Connection.ts";
import { Cell, type Readable } from "../Store.ts";
import { latestRead } from "./Settings.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** How far back the usage view counts turns. */
export const USAGE_PERIOD = Duration.days(1);

/** How many turns the first read takes, and how many more each `loadMore` adds. */
export const USAGE_PAGE = 200;

/** The turns of the last `USAGE_PERIOD`, as far as they are read. */
export interface RecentTurns {
  /** Turns that started after `since`, newest first. */
  readonly turns: ReadonlyArray<UsageTurn>;
  /** `USAGE_PERIOD` before the moment of the read. */
  readonly since: DateTime.Utc;
  /** Turns started after `since` that are older than the oldest read. */
  readonly hasMore: boolean;
  /** `loadMore` can read some of them: one read takes at most `MAX_USAGE_TURNS`. */
  readonly canLoadMore: boolean;
  /** A read of more turns is on its way. */
  readonly loadingMore: boolean;
}

/** Recent turns held open for the usage view. */
export interface RecentTurnsView {
  readonly state: Readable<Synced<RecentTurns>>;
  /** Reads `USAGE_PAGE` more turns, when `canLoadMore` and none are on their way. */
  readonly loadMore: Effect.Effect<void>;
}

/**
 * The turns bots spent recently, for the usage view. The contract has no
 * subscription for them, so they are read when the view opens and on every
 * socket while it stays open; a read of more turns reads them again with a
 * higher limit. The limit windows they spend come live with the engine's
 * status.
 */
export class Usage extends Context.Service<
  Usage,
  {
    /** Reads the recent turns, and again on each socket, until the scope closes. */
    readonly open: Effect.Effect<RecentTurnsView, never, Scope.Scope>;
  }
>()("@j3-bots/client-runtime/stores/Usage") {}

export const layer = Layer.effect(
  Usage,
  Effect.gen(function* () {
    const connection = yield* Connection;

    const open = Effect.gen(function* () {
      const state = new Cell<Synced<RecentTurns>>(loading);
      // How many turns a read asks for: the first page, and a page more for each `loadMore`.
      let wanted = USAGE_PAGE;
      const latest = latestRead((turns: RecentTurns) => state.set(ready(turns)));
      /** Reads the turns, and shows them unless a read started later is under way or done. */
      const read = (client: J3RpcClient) =>
        latest(
          Effect.gen(function* () {
            const limit = wanted;
            const since = DateTime.subtractDuration(yield* DateTime.now, USAGE_PERIOD);
            const page = yield* client["usage.turns"]({ since, limit });
            return {
              turns: page.turns,
              since,
              hasMore: page.hasMore,
              canLoadMore: page.hasMore && limit < MAX_USAGE_TURNS,
              loadingMore: limit < wanted,
            };
          }),
        );

      yield* connection
        .eachSession((client) =>
          read(client).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => state.update(markStale))),
          ),
        )
        .pipe(Effect.forkScoped);

      const loadMore = Effect.suspend(() => {
        const current = state.get();
        if (current._tag !== "ready" || !current.value.canLoadMore || current.value.loadingMore) {
          return Effect.void;
        }
        wanted = Math.min(wanted + USAGE_PAGE, MAX_USAGE_TURNS);
        state.set({ ...current, value: { ...current.value, loadingMore: true } });
        // Waits for a socket when there is none; a socket's own read then asks for as many.
        return connection.call(read).pipe(Effect.ignore);
      });

      return { state, loadMore } satisfies RecentTurnsView;
    });

    return Usage.of({ open });
  }),
);
