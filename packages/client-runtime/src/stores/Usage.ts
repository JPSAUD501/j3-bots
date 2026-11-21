// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_USAGE_TURNS, type UsageTurn } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as Scope from "effect/Scope";
import {
  Connection,
  type J3RpcClient,
  type NotPaired,
  ReconnectPolicy,
} from "../connection/Connection.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** How many turns the first read takes, and how many more each `loadMore` adds. */
export const USAGE_PAGE = 200;

/**
 * An error of the client's own on a socket that stays open, such as an answer
 * it cannot decode. The socket's errors end the socket, and the read runs
 * again on the next one.
 */
const onOpenSocket = (error: RpcClientError) => error.reason._tag === "RpcClientDefect";

/** The turns of the `USAGE_PERIOD` before one read, as far as it took them. */
export interface RecentTurns {
  /** Turns that started in the period, newest first. */
  readonly turns: ReadonlyArray<UsageTurn>;
  /** When the server read them: the period ends there, and later turns are not counted. */
  readonly readAt: DateTime.Utc;
  /** The period holds turns older than the oldest read. */
  readonly hasMore: boolean;
  /** `loadMore` can read some of them: one read takes at most `MAX_USAGE_TURNS`. */
  readonly canLoadMore: boolean;
}

/** The recent turns as the usage view holds them. */
export interface RecentTurnsState {
  /**
   * The turns as last read: `stale` from a disconnection until the read on
   * the next socket answers.
   */
  readonly read: Synced<RecentTurns>;
  /** More turns are asked for than `read` took: on their way, or on the next socket. */
  readonly loadingMore: boolean;
  /** The latest read failed. What was read before stays; `retry` reads again. */
  readonly failed: boolean;
}

/** Before the first read answers. */
export const turnsNotRead: RecentTurnsState = { read: loading, loadingMore: false, failed: false };

/** Recent turns held open for the usage view. */
export interface RecentTurnsView {
  readonly state: Readable<RecentTurnsState>;
  /** Reads `USAGE_PAGE` more turns, when `canLoadMore` and none are on their way. */
  readonly loadMore: Effect.Effect<void>;
  /** Reads the turns again after a read failed. */
  readonly retry: Effect.Effect<void>;
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
    const policy = yield* ReconnectPolicy;

    const open = Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const state = new Cell<RecentTurnsState>(turnsNotRead);
      // How many turns a read asks for: the first page, and a page more for each `loadMore`.
      let wanted = USAGE_PAGE;
      // How many the shown read asked for.
      let shown = 0;
      let started = 0;

      /**
       * Reads the turns and shows how the read ends, unless a read started
       * later is under way or done. A read the socket drops fails with the
       * socket's error, for the caller to read again on the next one; one
       * that fails otherwise, or gets no answer in time, shows as failed.
       */
      const read = (client: J3RpcClient) =>
        Effect.suspend(() => {
          const ticket = ++started;
          const limit = wanted;
          const latest = () => ticket === started;
          state.update((current) => (current.failed ? { ...current, failed: false } : current));
          // The turns read before stay, and `retry` reads again.
          const fail = (reason: unknown) =>
            Effect.logWarning("The recent turns could not be read", reason).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (latest()) {
                    state.update((current) => ({ ...current, loadingMore: false, failed: true }));
                  }
                }),
              ),
            );
          return client["usage.turns"]({ limit }).pipe(
            Effect.timeoutOption(policy.requestTimeout),
            Effect.flatMap(
              Option.match({
                onNone: () => fail("No answer in time"),
                onSome: (page) =>
                  Effect.sync(() => {
                    if (!latest()) return;
                    shown = limit;
                    state.set({
                      read: ready({
                        turns: page.turns,
                        readAt: page.readAt,
                        hasMore: page.hasMore,
                        canLoadMore: page.hasMore && limit < MAX_USAGE_TURNS,
                      }),
                      loadingMore: limit < wanted,
                      failed: false,
                    });
                  }),
              }),
            ),
            Effect.catchIf(onOpenSocket, fail),
            // The server fails a request alone with a generic defect.
            Effect.catchDefect(fail),
          );
        });

      yield* connection
        .eachSession((client) =>
          read(client).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() =>
                state.update((current) => ({ ...current, read: markStale(current.read) })),
              ),
            ),
          ),
        )
        .pipe(Effect.forkScoped);

      /**
       * Reads on the open socket, or on the next one, while the view stays
       * open. A read that fails says so itself; one that cannot start because
       * the device signed out leaves nothing on its way.
       */
      const readInView = (ask: Effect.Effect<void, NotPaired>) =>
        ask.pipe(
          Effect.catchTag("NotPaired", () =>
            Effect.sync(() => state.update((current) => ({ ...current, loadingMore: false }))),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        );

      const loadMore = Effect.suspend(() => {
        const current = state.get();
        if (
          current.read._tag !== "ready" ||
          !current.read.value.canLoadMore ||
          current.loadingMore ||
          current.failed
        ) {
          return Effect.void;
        }
        wanted = Math.min(wanted + USAGE_PAGE, MAX_USAGE_TURNS);
        state.set({ ...current, loadingMore: true });
        // A socket that opens meanwhile reads as many with its own read.
        return readInView(connection.call(read));
      });

      const retry = Effect.suspend(() => {
        const current = state.get();
        if (!current.failed) return Effect.void;
        state.set({
          ...current,
          failed: false,
          loadingMore: current.read._tag === "ready" && shown < wanted,
        });
        return readInView(connection.call(read));
      });

      return { state, loadMore, retry } satisfies RecentTurnsView;
    });

    return Usage.of({ open });
  }),
);
