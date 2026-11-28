// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BROWSER_CLOSE_CODES,
  BrowserClientFrame,
  type BrowserController,
  type BrowserInput,
  BrowserServerFrame,
  type BrowserTab,
  type BrowserTabRef,
  type BotId,
  type SharedBrowserTab,
  HTTP_PATHS,
  MAX_BROWSER_VIEW,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/socket/Socket";
import { backoffDelay, Connection, ReconnectPolicy } from "../connection/Connection.ts";
import { Actions, type IntentResult, intentResult } from "../intents/Actions.ts";
import { Lifecycle, type LifecycleState, Network, type NetworkStatus } from "../ports.ts";
import { Cell, type Readable } from "../Store.ts";
import { type Loaded, makeLive } from "./reads.ts";
import { Roster } from "./Roster.ts";

// The browser as a client follows it: the list of one bot's tabs, or of
// every tab on a server that shares them, on the RPC socket, and one tab's
// pictures and control, on a media socket of its own (`HTTP_PATHS.browser`).
// A picture is held in memory only until the next replaces it: nothing of
// the page is kept on the device.

/** Why a view shows no live page, or that it does. */
export type BrowserViewStatus =
  /** The first socket is opening. */
  | { readonly _tag: "connecting" }
  | { readonly _tag: "live" }
  /** The socket dropped and the view is opening another; a tab this device held stays held by the server's rules. */
  | { readonly _tag: "reconnecting" }
  /** The app is in the background: no socket until it returns. */
  | { readonly _tag: "paused" }
  /** The tab is closed. Nothing more comes. */
  | { readonly _tag: "gone" }
  /** The server's browser cannot start until its host is set up. Nothing more comes. */
  | { readonly _tag: "setup-needed"; readonly need: "sandbox" | "libraries" }
  /** This device opened the tab on another socket, which took its place. Nothing more comes. */
  | { readonly _tag: "replaced" }
  /** The server refused the view: the tab or size was not valid, or this device is not paired. */
  | { readonly _tag: "failed" };

/** Who acts on the tab, from this view's point of view, and the dialog the page waits on. */
export interface BrowserControl {
  readonly controller: BrowserController;
  /** Grows with each change of hands. */
  readonly generation: number;
  readonly dialog: Extract<BrowserServerFrame, { readonly type: "control" }>["dialog"];
}

/**
 * What a view shows besides the picture. The page's size and its control
 * stay as last heard while the view reconnects, so a screen need not blank.
 */
export interface BrowserViewState {
  readonly status: BrowserViewStatus;
  /** The page's size in CSS pixels: the space input coordinates are in. */
  readonly viewport: { readonly width: number; readonly height: number } | null;
  readonly control: BrowserControl | null;
}

/** One picture of the page. `ack` it with its `sequence` once drawn, and the next comes. */
export interface BrowserPicture {
  readonly jpeg: Uint8Array;
  readonly sequence: number;
}

/** The answer to a `probe`. `sequence` grows with each answer, so the same point twice is told apart. */
export interface BrowserProbe {
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
  readonly sequence: number;
}

/**
 * Where a bot points while it acts on the tab, in page CSS pixels, and
 * whether it clicked there. `sequence` grows with each, so a second click on
 * the same point is told apart. `botId` is null from a server before shared
 * tabs, whose tabs have one bot each.
 */
export interface BrowserCursor {
  readonly action: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly botId: BotId | null;
  readonly sequence: number;
}

/**
 * The picture a view asks for, read again for each socket, so a phone that
 * moved to a cellular network asks for less on the next one. Left out, the
 * server's default applies; past what the server takes, the most it takes,
 * as a phone's screen is taller than the largest picture.
 */
export interface BrowserViewSize {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly quality?: number;
}

/** The smallest side of a picture the server takes, in device pixels. */
const MIN_BROWSER_SIDE = 64;

/** `value` as a whole number between `minimum` and `maximum`, as a query parameter. */
const within = (value: number, minimum: number, maximum: number): string =>
  String(Math.min(maximum, Math.max(minimum, Math.round(value))));

export interface BrowserView {
  readonly state: Readable<BrowserViewState>;
  /** The newest picture, null until the first. */
  readonly picture: Readable<BrowserPicture | null>;
  /** The newest answer to a `probe`, null until the first. */
  readonly probe: Readable<BrowserProbe | null>;
  /** A bot's newest pointer, null until the first. Nothing comes while a person holds the tab. */
  readonly cursor: Readable<BrowserCursor | null>;
  /**
   * The picture `sequence` is drawn: the server sends the next. An
   * acknowledgement of any other picture, or of one from a socket since
   * replaced, does nothing.
   */
  readonly ack: (sequence: number) => Effect.Effect<void>;
  /**
   * Sends what the operator did. Input made while the view has no socket is
   * dropped, being about a page the operator no longer sees, except taking
   * and giving back the tab, which the next socket carries.
   */
  readonly send: (input: BrowserInput) => Effect.Effect<void>;
}

/** How long a socket may stay silent: the server pings every 15 s. */
const BROWSER_SILENT_LIMIT = Duration.seconds(45);
/** The longest pause between attempts to open a view's socket: a person waits on it. */
const MAX_RETRY_DELAY = Duration.seconds(10);

const decodeServerFrame = Schema.decodeUnknownOption(Schema.fromJsonString(BrowserServerFrame));
const encodeClientFrame = Schema.encodeSync(Schema.fromJsonString(BrowserClientFrame));

/** How one socket ended. */
type SocketOutcome =
  | { readonly _tag: "final"; readonly status: BrowserViewStatus }
  /** Open the next socket at once: the browser restarted. */
  | { readonly _tag: "reconnect" }
  /** Open the next socket after a pause. `opened`: this one was open, which starts the count again. */
  | { readonly _tag: "retry"; readonly opened: boolean }
  | { readonly _tag: "background" }
  | { readonly _tag: "offline" };

/** The outcome a close code means, for a socket that was open or not. */
const closedWith = (code: number, opened: boolean): SocketOutcome => {
  switch (code) {
    case BROWSER_CLOSE_CODES.invalid:
      return { _tag: "final", status: { _tag: "failed" } };
    case BROWSER_CLOSE_CODES.replaced:
      return { _tag: "final", status: { _tag: "replaced" } };
    case BROWSER_CLOSE_CODES.reconnect:
      return { _tag: "reconnect" };
    default:
      return { _tag: "retry", opened };
  }
};

/** A socket that sent nothing, not even a ping, for `BROWSER_SILENT_LIMIT`. */
class Silent extends Schema.TaggedError<Silent>()("Silent", {}) {}

/**
 * The browser: a bot's tabs and every tab, live while held, views of one tab
 * each, for as long as their scope lives, and opening and closing tabs.
 * Closing a view closes its socket and nothing else: a tab this device holds
 * stays its own until its hold ends.
 */
export class Browser extends Context.Service<
  Browser,
  {
    readonly tabs: (
      botId: BotId,
    ) => Effect.Effect<Readable<Loaded<ReadonlyArray<BrowserTab>>>, never, Scope.Scope>;
    /**
     * Every tab, the person's own and private ones included. Stays loading
     * on a server that does not share its tabs (`Roster.sharedBrowser`).
     */
    readonly allTabs: Effect.Effect<
      Readable<Loaded<ReadonlyArray<SharedBrowserTab>>>,
      never,
      Scope.Scope
    >;
    /** Opens a tab for the person, at `url` or blank, where a new tab opens. */
    readonly open: (url: string | null) => Effect.Effect<IntentResult<BrowserTabRef>>;
    /** Closes a tab for the person. */
    readonly close: (ref: BrowserTabRef) => Effect.Effect<IntentResult>;
    readonly view: (input: {
      readonly ref: BrowserTabRef;
      readonly size: () => BrowserViewSize;
    }) => Effect.Effect<BrowserView, never, Scope.Scope>;
  }
>()("@j3-bots/client-runtime/stores/Browser") {}

export const layer = Layer.effect(
  Browser,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const scope = yield* Scope.Scope;
    const lifecycle = yield* Lifecycle;
    const network = yield* Network;
    const makeWebSocket = yield* Socket.WebSocketConstructor;
    const policy = yield* ReconnectPolicy;
    const roster = yield* Roster;
    const actions = yield* Actions;

    const tabs = makeLive<BotId, ReadonlyArray<BrowserTab>>({
      scope,
      connection,
      keyOf: (botId) => botId,
      follow: (botId, client, set) =>
        client["browser.subscribe"]({ botId }).pipe(
          Stream.runForEach((frame) => set(() => frame.tabs)),
        ),
    });

    const shared = makeLive<"all", ReadonlyArray<SharedBrowserTab>>({
      scope,
      connection,
      keyOf: (key) => key,
      follow: (_key, client, set) =>
        roster
          .sharedBrowserOn(client)
          .pipe(
            Effect.flatMap((on) =>
              on
                ? client["browser.subscribeAll"]().pipe(
                    Stream.runForEach((frame) => set(() => frame.tabs)),
                  )
                : Effect.never,
            ),
          ),
    });

    const open = Effect.fn("Browser.open")(function* (url: string | null) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["browser.open"](url === null ? { commandId } : { commandId, url }))
        .pipe(
          Effect.map(({ ref }) => ref),
          Effect.exit,
          Effect.map(intentResult),
        );
    });

    const close = Effect.fn("Browser.close")(function* (ref: BrowserTabRef) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["browser.close"]({ commandId, ref }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const view = Effect.fnUntraced(function* (input: {
      readonly ref: BrowserTabRef;
      readonly size: () => BrowserViewSize;
    }) {
      const state = new Cell<BrowserViewState>({
        status: { _tag: "connecting" },
        viewport: null,
        control: null,
      });
      const picture = new Cell<BrowserPicture | null>(null);
      const probe = new Cell<BrowserProbe | null>(null);
      const cursor = new Cell<BrowserCursor | null>(null);
      const setStatus = (status: BrowserViewStatus) => state.update((now) => ({ ...now, status }));

      /** Writes a frame on the open socket, if any. */
      let write: ((frame: BrowserClientFrame) => Effect.Effect<boolean>) | null = null;
      /** The picture the server waits to hear was drawn, on the open socket. */
      let owed: number | null = null;
      let sequence = 0;
      let probes = 0;
      let pointers = 0;
      /** Taking or giving back the tab, asked for while no socket was open, as it was asked. */
      let control: Extract<BrowserInput, { readonly type: "take" | "release" }> | null = null;

      // What the device says it is doing is read on the view's own fiber: a
      // phone answers it asynchronously, and opening a view waits for nothing.
      const live = Effect.gen(function* () {
        const lifecycleState = yield* SubscriptionRef.make<LifecycleState>(yield* lifecycle.state);
        const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(yield* network.status);
        yield* Effect.forkScoped(
          Stream.runForEach(lifecycle.changes, (next) => SubscriptionRef.set(lifecycleState, next)),
        );
        yield* Effect.forkScoped(
          Stream.runForEach(network.changes, (next) => SubscriptionRef.set(networkStatus, next)),
        );
        const firstChange = <A>(
          ref: SubscriptionRef.SubscriptionRef<A>,
          predicate: (a: A) => boolean,
        ) =>
          SubscriptionRef.changes(ref).pipe(
            Stream.filter(predicate),
            Stream.runHead,
            Effect.asVoid,
          );
        const toBackground = firstChange(lifecycleState, (next) => next === "background");
        const toOffline = firstChange(networkStatus, (next) => next === "offline");

        /** Handles one message; succeeds with the view's end when the server said it. */
        const receive = (
          message: Uint8Array | string,
          send: (frame: BrowserClientFrame) => Effect.Effect<boolean>,
        ): Effect.Effect<BrowserViewStatus | null> => {
          if (typeof message !== "string") {
            sequence += 1;
            owed = sequence;
            picture.set({ jpeg: message, sequence });
            return Effect.succeed(null);
          }
          const frame = decodeServerFrame(message);
          // A frame this client does not know is passed over.
          if (Option.isNone(frame)) return Effect.succeed(null);
          const value = frame.value;
          switch (value.type) {
            case "viewport":
              state.update((now) => ({
                ...now,
                viewport: { width: value.width, height: value.height },
              }));
              return Effect.succeed(null);
            case "control":
              state.update((now) => ({
                ...now,
                control: {
                  controller: value.controller,
                  generation: value.generation,
                  dialog: value.dialog,
                },
              }));
              return Effect.succeed(null);
            case "probe":
              probes += 1;
              probe.set({ x: value.x, y: value.y, editable: value.editable, sequence: probes });
              return Effect.succeed(null);
            case "cursor":
              pointers += 1;
              cursor.set({
                action: value.action,
                x: value.x,
                y: value.y,
                botId: value.botId ?? null,
                sequence: pointers,
              });
              return Effect.succeed(null);
            case "ping":
              return send({ type: "pong" }).pipe(Effect.as(null));
            case "gone":
              return Effect.succeed({ _tag: "gone" });
            case "setup-needed":
              return Effect.succeed({ _tag: "setup-needed", need: value.need });
          }
        };

        /** One socket, from its address to its end. */
        const once: Effect.Effect<SocketOutcome> = Effect.gen(function* () {
          const { maxWidth, maxHeight, quality } = input.size();
          const query: Record<string, string> = { ref: input.ref };
          if (maxWidth !== undefined) {
            query["maxWidth"] = within(maxWidth, MIN_BROWSER_SIDE, MAX_BROWSER_VIEW.width);
          }
          if (maxHeight !== undefined) {
            query["maxHeight"] = within(maxHeight, MIN_BROWSER_SIDE, MAX_BROWSER_VIEW.height);
          }
          if (quality !== undefined) query["quality"] = within(quality, 1, 100);
          const address = yield* connection.socketAddress(HTTP_PATHS.browser, query);
          const socket = yield* Socket.makeWebSocket(address, {
            openTimeout: policy.openTimeout,
          }).pipe(Effect.provideService(Socket.WebSocketConstructor, makeWebSocket));
          const reader = yield* socket.reader;
          const writer = yield* socket.writer;
          const send = (frame: BrowserClientFrame) =>
            writer.write(encodeClientFrame(frame)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
          owed = null;
          write = send;
          setStatus({ _tag: "live" });
          if (control !== null) {
            const asked = control;
            if (yield* send(asked)) control = null;
          }
          while (true) {
            const messages = yield* reader.pull.pipe(
              Effect.timeoutOrElse({
                duration: BROWSER_SILENT_LIMIT,
                orElse: () => Effect.fail(new Silent()),
              }),
            );
            for (const message of messages) {
              const ended = yield* receive(message, send);
              if (ended !== null) return { _tag: "final", status: ended } as const;
            }
          }
        }).pipe(
          Effect.catchTags({
            NotPaired: () =>
              Effect.succeed<SocketOutcome>({ _tag: "final", status: { _tag: "failed" } }),
            ServerUnreachable: () =>
              Effect.succeed<SocketOutcome>({ _tag: "retry", opened: false }),
            Silent: () => Effect.succeed<SocketOutcome>({ _tag: "retry", opened: true }),
            SocketError: (error) =>
              Effect.succeed<SocketOutcome>(
                error.reason._tag === "SocketCloseError"
                  ? closedWith(error.reason.code, write !== null)
                  : { _tag: "retry", opened: write !== null },
              ),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              write = null;
              owed = null;
            }),
          ),
          Effect.scoped,
          Effect.raceFirst(toBackground.pipe(Effect.as<SocketOutcome>({ _tag: "background" }))),
          Effect.raceFirst(toOffline.pipe(Effect.as<SocketOutcome>({ _tag: "offline" }))),
        );

        const run = Effect.gen(function* () {
          let failures = 0;
          while (true) {
            if ((yield* SubscriptionRef.get(lifecycleState)) === "background") {
              setStatus({ _tag: "paused" });
              yield* firstChange(lifecycleState, (next) => next === "foreground");
              failures = 0;
              continue;
            }
            if ((yield* SubscriptionRef.get(networkStatus)) === "offline") {
              setStatus({ _tag: "reconnecting" });
              yield* firstChange(networkStatus, (next) => next !== "offline").pipe(
                Effect.raceFirst(toBackground),
              );
              failures = 0;
              continue;
            }
            const outcome = yield* once;
            switch (outcome._tag) {
              case "final":
                setStatus(outcome.status);
                return;
              case "background":
              case "offline":
                failures = 0;
                continue;
              case "reconnect":
                failures = 0;
                setStatus({ _tag: "reconnecting" });
                continue;
              case "retry": {
                failures = outcome.opened ? 1 : failures + 1;
                if (state.get().status._tag !== "connecting") setStatus({ _tag: "reconnecting" });
                const delay = backoffDelay(
                  failures,
                  { initialDelay: policy.initialDelay, maxDelay: MAX_RETRY_DELAY },
                  yield* Random.next,
                );
                // Going to the background ends the pause: the app's return opens the next socket.
                yield* toBackground.pipe(
                  Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void }),
                );
                continue;
              }
            }
          }
        });
        yield* run;
      });
      yield* Effect.forkScoped(live);

      return {
        state,
        picture,
        probe,
        cursor,
        ack: (drawn) =>
          Effect.suspend(() => {
            if (write === null || owed !== drawn) return Effect.void;
            owed = null;
            return write({ type: "ack" }).pipe(Effect.asVoid);
          }),
        send: (frame) =>
          Effect.suspend(() => {
            const asked = frame.type === "take" || frame.type === "release" ? frame : null;
            if (write === null) {
              if (asked !== null) control = asked;
              return Effect.void;
            }
            if (asked !== null) control = null;
            return write(frame).pipe(
              Effect.tap((sent) =>
                Effect.sync(() => {
                  if (!sent && asked !== null) control = asked;
                }),
              ),
              Effect.asVoid,
            );
          }),
      } satisfies BrowserView;
    });

    return Browser.of({ tabs: tabs.acquire, allTabs: shared.acquire("all"), open, close, view });
  }),
);
