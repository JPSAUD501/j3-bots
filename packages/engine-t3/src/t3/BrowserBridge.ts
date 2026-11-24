// SPDX-License-Identifier: AGPL-3.0-or-later
import { AuthWebSocketTicketResult, type PreviewEvent, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Socket from "effect/socket/Socket";
import {
  BrowserBridge,
  type BrowserViewer,
  type EngineBrowserTab,
  ViewerClosed,
  type ViewerOutput,
} from "../Browser.ts";
import { EngineUnavailable } from "../errors.ts";
import type { SessionId } from "../ids.ts";
import {
  ACK,
  closeOf,
  decodeTextFrame,
  encodeInput,
  millisOf,
  pageOf,
  PREVIEW_STREAM_PATH,
  tabKeyOf,
  tabOf,
} from "./browserProtocol.ts";
import type { makeEngineRpc } from "./Connection.ts";
import { type ProcessState, stateChanges } from "./Supervisor.ts";
import { baseUrl } from "./Supervisor.ts";

// The engine's browser for J3 Bots: the tabs of every session, followed by the
// engine's list of each session's tabs and its feed of tab events, and one
// connection to the engine's preview stream per viewer. Listing and following
// tabs needs `orchestration:read`; acting on one needs `preview:operate` in
// the engine credential (`Credential.ts`), without which the engine silently
// drops a viewer's input. **Read** at `59651c1`,
// `apps/server/src/auth/RpcAuthorization.ts` L208-217 and
// `preview/ServerBrowserStream.ts` L74-77.

type EngineRpc = Effect.Success<ReturnType<typeof makeEngineRpc>>;

const decodeTicket = HttpClientResponse.schemaBodyJson(AuthWebSocketTicketResult);

/** How long to wait before following the engine's tab events again after the feed ended. */
const RESUBSCRIBE = Duration.seconds(2);
/** How long one session's listing may take. */
const LIST_TIMEOUT = Duration.seconds(5);
const OPEN_TIMEOUT = Duration.seconds(10);

const sameTabs = (left: ReadonlyArray<EngineBrowserTab>, right: ReadonlyArray<EngineBrowserTab>) =>
  left.length === right.length &&
  left.every((tab, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      tab.id === other.id &&
      tab.url === other.url &&
      tab.title === other.title &&
      tab.loading === other.loading &&
      tab.activeAt === other.activeAt
    );
  });

/**
 * The tabs the engine knows, as its list and its events say. Events of the
 * engine's earlier process, or no newer than a listing of their thread, are
 * passed over: the engine numbers both from one counter (`revision`).
 */
const makeTabState = () => {
  let epoch: string | null = null;
  const tabs = new Map<string, EngineBrowserTab>();
  /** The revision each thread was listed at. */
  const listedAt = new Map<string, number>();

  const keyOf = (threadId: string, tabId: string) => JSON.stringify([threadId, tabId]);

  const resetTo = (serverEpoch: string) => {
    if (epoch === serverEpoch) return;
    epoch = serverEpoch;
    tabs.clear();
    listedAt.clear();
  };

  return {
    listed: (
      threadId: string,
      listing: {
        readonly sessions: ReadonlyArray<Parameters<typeof tabOf>[0]>;
        readonly serverEpoch: string;
        readonly revision: number;
      },
    ) => {
      resetTo(listing.serverEpoch);
      for (const [key, tab] of tabs) if (tab.sessionId === threadId) tabs.delete(key);
      for (const snapshot of listing.sessions) {
        const tab = tabOf(snapshot, millisOf(snapshot.updatedAt));
        if (Option.isSome(tab)) tabs.set(keyOf(snapshot.threadId, snapshot.tabId), tab.value);
      }
      listedAt.set(threadId, listing.revision);
    },
    /** Applies one event; whether the list changed. */
    apply: (event: PreviewEvent): boolean => {
      resetTo(event.serverEpoch);
      if (event.revision <= (listedAt.get(event.threadId) ?? 0)) return false;
      const key = keyOf(event.threadId, event.tabId);
      const existing = tabs.get(key);
      switch (event.type) {
        case "opened":
        case "navigated":
        case "resized": {
          const activeAt =
            event.type === "resized" && existing !== undefined
              ? existing.activeAt
              : millisOf(event.createdAt);
          const tab = tabOf(event.snapshot, activeAt);
          if (Option.isNone(tab)) return tabs.delete(key);
          tabs.set(key, tab.value);
          return true;
        }
        case "failed":
          if (existing === undefined) return false;
          tabs.set(key, {
            ...existing,
            url: event.url,
            title: event.title,
            loading: false,
            activeAt: millisOf(event.createdAt),
          });
          return true;
        case "closed":
          return tabs.delete(key);
      }
    },
    current: (): ReadonlyArray<EngineBrowserTab> =>
      [...tabs.values()].sort((left, right) =>
        left.activeAt === right.activeAt
          ? left.id.localeCompare(right.id)
          : right.activeAt - left.activeAt,
      ),
  };
};

/** A viewer over one connection to the engine's preview stream. */
export const viewerOf = Effect.fnUntraced(function* (socket: Socket.Socket) {
  const writer = yield* socket.writer;
  const reader = yield* socket.reader;
  const write = (message: string) => writer.write(message).pipe(Effect.ignore);
  const output: Stream.Stream<ViewerOutput, ViewerClosed> = Stream.fromEffectRepeat(
    reader.pull,
  ).pipe(
    Stream.mapError((error) =>
      error.reason._tag === "SocketCloseError"
        ? closeOf(error.reason.code, error.reason.closeReason)
        : new ViewerClosed({ reason: "lost" }),
    ),
    Stream.flatMap((chunks) => Stream.fromIterable(chunks)),
    Stream.filterMap((chunk) =>
      typeof chunk === "string"
        ? Result.fromOption(decodeTextFrame(chunk), () => undefined)
        : Result.succeed<ViewerOutput>({ _tag: "frame", jpeg: chunk }),
    ),
  );
  return {
    output,
    ack: write(ACK),
    send: (input) => write(encodeInput(input)),
  } satisfies BrowserViewer;
});

export const makeBrowserBridge = (input: {
  readonly rpc: EngineRpc;
  readonly state: SubscriptionRef.SubscriptionRef<ProcessState>;
  readonly port: number;
  readonly token: Effect.Effect<Redacted.Redacted<string>>;
  readonly http: HttpClient.HttpClient;
}) => {
  const { rpc } = input;

  const isReady = SubscriptionRef.get(input.state).pipe(
    Effect.map((current) => current._tag === "ready"),
  );

  /** Lists the sessions' tabs afresh, then follows the engine's events until they end. */
  const follow = (sessions: Effect.Effect<ReadonlyArray<SessionId>>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const state = makeTabState();
        // Subscribed before listing. The engine says nothing once the subscription
        // holds, so an event in between is caught only if it took hold first (engine.md).
        const events = yield* Stream.toQueue(rpc["subscribePreviewEvents"]({}), {
          capacity: "unbounded",
        });
        for (const sessionId of yield* sessions) {
          const listing = yield* rpc["preview.list"]({ threadId: ThreadId.make(sessionId) }).pipe(
            Effect.timeout(LIST_TIMEOUT),
            Effect.option,
          );
          if (Option.isSome(listing)) state.listed(sessionId, listing.value);
        }
        return Stream.concat(
          Stream.make(state.current()),
          Stream.fromQueue(events).pipe(
            Stream.filterMap((event) =>
              state.apply(event) ? Result.succeed(state.current()) : Result.failVoid,
            ),
          ),
        );
      }),
    ).pipe(
      Stream.catchCause(() => Stream.empty),
      Stream.repeat(Schedule.spaced(RESUBSCRIBE)),
    );

  const tabs = (sessions: Effect.Effect<ReadonlyArray<SessionId>>) =>
    stateChanges(input.state).pipe(
      Stream.map((current) => current._tag === "ready"),
      Stream.changes,
      Stream.switchMap((ready) =>
        ready ? follow(sessions) : Stream.succeed<ReadonlyArray<EngineBrowserTab>>([]),
      ),
      Stream.changesWith(sameTabs),
    );

  /** The stream's address for one viewer, with a one-use ticket for its upgrade. */
  const streamUrl = Effect.fnUntraced(function* (target: {
    readonly threadId: string;
    readonly tabId: string;
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly quality: number;
  }) {
    const token = yield* input.token;
    const ticket = yield* input.http
      .execute(
        HttpClientRequest.post(`${baseUrl(input.port)}/api/auth/websocket-ticket/media`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decodeTicket),
        Effect.timeout(Duration.seconds(5)),
        Effect.mapError(() => new EngineUnavailable()),
      );
    const url = new URL(`${baseUrl(input.port).replace("http:", "ws:")}${PREVIEW_STREAM_PATH}`);
    url.searchParams.set("threadId", target.threadId);
    url.searchParams.set("tabId", target.tabId);
    url.searchParams.set("maxWidth", String(target.maxWidth));
    url.searchParams.set("maxHeight", String(target.maxHeight));
    url.searchParams.set("quality", String(target.quality));
    url.searchParams.set("wsTicket", Redacted.value(ticket.ticket));
    return url.toString();
  });

  /**
   * The engine's own listing of the tab's thread, asked now: the page of the
   * tab, if a bot still drives it. A tab a person opened is no bot's, so it
   * is gone here as it is from `tabs`.
   */
  const readTab = Effect.fn("BrowserBridge.readTab")(function* (
    tab: Parameters<BrowserBridge["Service"]["readTab"]>[0],
  ) {
    if (!(yield* isReady)) return yield* new EngineUnavailable();
    const key = tabKeyOf(tab);
    if (Option.isNone(key)) return Option.none();
    const listing = yield* rpc["preview.list"]({
      threadId: ThreadId.make(key.value.threadId),
    }).pipe(
      Effect.timeout(LIST_TIMEOUT),
      Effect.mapError(() => new EngineUnavailable()),
    );
    const snapshot = listing.sessions.find(
      (candidate) => candidate.tabId === key.value.tabId && Option.isSome(tabOf(candidate, 0)),
    );
    return Option.map(Option.fromUndefinedOr(snapshot), pageOf);
  });

  /** A viewer whose tab this package never named: gone from the start. */
  const goneViewer: BrowserViewer = {
    output: Stream.fail(new ViewerClosed({ reason: "gone" })),
    ack: Effect.void,
    send: () => Effect.void,
  };

  const openViewer = Effect.fn("BrowserBridge.openViewer")(function* (target: {
    readonly tab: Parameters<BrowserBridge["Service"]["openViewer"]>[0]["tab"];
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly quality: number;
  }): Effect.fn.Return<BrowserViewer, EngineUnavailable, Scope.Scope> {
    if (!(yield* isReady)) return yield* new EngineUnavailable();
    const key = tabKeyOf(target.tab);
    if (Option.isNone(key)) return goneViewer;
    const url = yield* streamUrl({ ...key.value, ...target });
    const socket = yield* Socket.makeWebSocket(url, { openTimeout: OPEN_TIMEOUT }).pipe(
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
    );
    return yield* viewerOf(socket).pipe(Effect.mapError(() => new EngineUnavailable()));
  });

  return BrowserBridge.of({ tabs, readTab, openViewer });
};
