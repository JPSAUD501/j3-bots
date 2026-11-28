// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PageHost } from "@j3-bots/browser";
import {
  BROWSER_CLOSE_CODES,
  type BrowserClientFrame,
  type BrowserController,
  type BrowserHostError,
  type BrowserScreencastFrame,
  type BrowserServerFrame,
  type BrowserTabRef,
  DEFAULT_BROWSER_VIEW,
  type DeviceId,
  type SharedBrowserTab,
} from "@j3-bots/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { Browser, type WatchedTab } from "./Browser.ts";

// What the server does between clients' media sockets and J3 Bots' tabs
// (decision 0110). Every socket on a tab shares one screencast of it, from
// the host the tab runs on now, which follows the tab when it moves; while
// the tab has no host its sockets stay open with the last picture. The host
// is asked for its next picture once the fastest socket drew the last, and
// each socket gets the newest picture whenever it is free. A device has one
// socket per tab: its next takes the place of the one before. Pictures are
// held in memory only, never written anywhere, logged or kept once the last
// socket on the tab closes.

/** How often the server pings a socket, and how long a silent socket lasts. */
const PING_EVERY = Duration.seconds(15);
export const SILENT_LIMIT = Duration.seconds(45);

/** The client's socket stopped taking messages, or was closed. */
export class LinkClosed extends Schema.TaggedError<LinkClosed>()("LinkClosed", {}) {}

/** The client's end of one media socket, as the route made it. */
export interface ClientLink {
  /** A picture, as one binary message, or a frame as JSON text. */
  readonly send: (message: Uint8Array | BrowserServerFrame) => Effect.Effect<void, LinkClosed>;
  readonly close: (code: number, reason: string) => Effect.Effect<void>;
  /** What the client sends, decoded; ends when the socket closes. */
  readonly incoming: Stream.Stream<BrowserClientFrame>;
}

/** The size and quality a socket asks for. */
interface ViewSize {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
}

/**
 * Whether a host's screencast failed for a reason that can pass: it was
 * refused (a host from before let only one run a tab), its call failed or
 * took too long, or the page failed.
 */
const passing = (error: BrowserHostError): boolean => {
  switch (error.reason) {
    case "refused":
    case "closed":
    case "timeout":
    case "page":
      return true;
    case "no-tab":
    case "stale-ref":
    case "invalid-target":
    case "not-editable":
    case "too-large":
    case "unsupported":
      return false;
  }
};

/**
 * How a feed asks a host again for a screencast that failed for a reason
 * that can pass: soon, then less often, at most every 5 s, while it lives.
 */
const SCREENCAST_RETRY = Schedule.min([
  Schedule.exponential(Duration.millis(250)),
  Schedule.spaced(Duration.seconds(5)),
]);

export const DEFAULT_VIEW_SIZE: ViewSize = {
  maxWidth: DEFAULT_BROWSER_VIEW.width,
  maxHeight: DEFAULT_BROWSER_VIEW.height,
  quality: DEFAULT_BROWSER_VIEW.quality,
};

export class BrowserViewers extends Context.Service<
  BrowserViewers,
  {
    /**
     * Serves one media socket of `deviceId` on the tab `ref` names, until the
     * socket closes or goes silent, another socket of the device on the tab
     * takes its place, the tab closes, or the device is revoked.
     */
    readonly connect: (input: {
      readonly deviceId: DeviceId;
      readonly ref: BrowserTabRef;
      readonly size: ViewSize;
      readonly link: ClientLink;
    }) => Effect.Effect<void>;
  }
>()("@j3-bots/server/browser/BrowserViewers") {}

/** One picture of the tab, numbered in the order the feed got them. */
interface Picture {
  readonly seq: number;
  readonly jpeg: Uint8Array;
}

/** How a socket is closed: the last frame it gets, and the code it closes with. */
interface Closing {
  readonly frame: BrowserServerFrame | null;
  readonly code: number;
  readonly reason: string;
}

const GONE: Closing = { frame: { type: "gone" }, code: 1000, reason: "gone" };
const REVOKED: Closing = { frame: null, code: BROWSER_CLOSE_CODES.invalid, reason: "revoked" };
const REPLACED: Closing = {
  frame: null,
  code: BROWSER_CLOSE_CODES.replaced,
  reason: "replaced",
};

/** One socket on a tab. */
interface Viewer {
  readonly deviceId: DeviceId;
  readonly link: ClientLink;
  /** Completed to end the socket: with how it closes, or null when it already left. */
  readonly ended: Deferred.Deferred<Closing | null>;
  /** Sent, not acknowledged yet. */
  inFlight: Picture | null;
  /** The newest picture, waiting for the one in flight. */
  pending: Picture | null;
}

/** Every socket on one tab, and the screencast they share. */
interface Feed {
  readonly ref: BrowserTabRef;
  readonly watched: WatchedTab;
  readonly scope: Scope.Closeable;
  readonly lock: Semaphore.Semaphore;
  readonly viewers: Set<Viewer>;
  /** The host the tab runs on now, for the people's input. */
  host: Option.Option<PageHost>;
  latest: Picture | null;
  /** The host's picture not acknowledged yet: the host sends the next only after it is. */
  owed: { readonly seq: number; readonly host: PageHost; readonly frame: number } | null;
  viewport: { readonly width: number; readonly height: number } | null;
  tab: SharedBrowserTab | null;
  generation: number;
  nextSeq: number;
}

/** Who acts on the tab, as a socket of `device` sees it. */
const controllerFor = (tab: SharedBrowserTab, device: DeviceId): BrowserController => {
  const holder = tab.heldBy;
  if (holder?.kind === "person") return holder.device === device ? "you" : "another-device";
  if (holder !== null || tab.acting !== null || tab.onIt.length > 0) return "bot";
  return "nobody";
};

const controlFrame = (feed: Feed, device: DeviceId): BrowserServerFrame | null =>
  feed.tab === null
    ? null
    : {
        type: "control",
        controller: controllerFor(feed.tab, device),
        generation: feed.generation,
        dialog: feed.tab.dialog,
      };

/** Closes `link` as `closing` says. */
const closeAs = Effect.fnUntraced(function* (link: ClientLink, closing: Closing) {
  if (closing.frame !== null) yield* link.send(closing.frame).pipe(Effect.ignore);
  yield* link.close(closing.code, closing.reason);
});

export const layer = Layer.effect(
  BrowserViewers,
  Effect.gen(function* () {
    const browser = yield* Browser;
    const auth = yield* DeviceAuth;
    const feeds = new Map<BrowserTabRef, Feed>();
    /** Feeds open and close one at a time, so two sockets never open two feeds of one tab. */
    const feedLock = yield* Semaphore.make(1);

    /** Sends to a viewer; one whose socket cannot take it is ended. */
    const sendTo = (viewer: Viewer, message: Uint8Array | BrowserServerFrame) =>
      viewer.link
        .send(message)
        .pipe(Effect.catch(() => Deferred.succeed(viewer.ended, null).pipe(Effect.asVoid)));

    const sendPicture = (viewer: Viewer, picture: Picture) =>
      Effect.suspend(() => {
        viewer.inFlight = picture;
        return sendTo(viewer, picture.jpeg);
      });

    const sendAll = (feed: Feed, frame: (viewer: Viewer) => BrowserServerFrame | null) =>
      Effect.forEach(
        [...feed.viewers],
        (viewer) => {
          const message = frame(viewer);
          return message === null ? Effect.void : sendTo(viewer, message);
        },
        { discard: true },
      );

    /** A picture from the host: each free socket gets it, the others get it next. */
    const received = (feed: Feed, host: PageHost, frame: BrowserScreencastFrame) =>
      feed.lock.withPermits(1)(
        Effect.gen(function* () {
          const picture: Picture = { seq: feed.nextSeq++, jpeg: frame.jpeg };
          feed.latest = picture;
          feed.owed = { seq: picture.seq, host, frame: frame.frame };
          const { width, height } = frame.viewport;
          if (feed.viewport?.width !== width || feed.viewport.height !== height) {
            feed.viewport = { width, height };
            yield* sendAll(feed, () => ({ type: "viewport", width, height }));
          }
          for (const viewer of feed.viewers) {
            if (viewer.inFlight === null) yield* sendPicture(viewer, picture);
            else viewer.pending = picture;
          }
        }),
      );

    /** Gives the host its acknowledgement once a socket drew its newest picture. */
    const settle = (feed: Feed, drawn: Picture) =>
      Effect.suspend(() => {
        const owed = feed.owed;
        if (owed === null || owed.seq !== drawn.seq) return Effect.void;
        feed.owed = null;
        return owed.host.screencastAck({ tab: feed.ref, frame: owed.frame }).pipe(Effect.ignore);
      });

    /**
     * The tab's screencast, from each host it runs on in turn, at the size
     * the feed's first socket asked for. A host that fails or refuses it is
     * asked again while the feed lives (`SCREENCAST_RETRY`), for a reason
     * that can pass (`passing`). Any other leaves the sockets with the last
     * picture until the tab moves. The same host told again changes nothing.
     */
    const screencast = (feed: Feed, size: ViewSize) =>
      feed.watched.host.pipe(
        Stream.changesWith((one, other) =>
          Option.isNone(one)
            ? Option.isNone(other)
            : Option.isSome(other) && one.value === other.value,
        ),
        Stream.tap((host) =>
          Effect.sync(() => {
            feed.host = host;
            feed.owed = null;
          }),
        ),
        Stream.switchMap((host) =>
          Option.match(host, {
            onNone: () => Stream.empty,
            onSome: (current) => {
              // Said once for each run of failures: a picture that comes ends the run.
              let failing = false;
              return Stream.unwrap(
                Effect.sync(() => {
                  // A screencast starts over: nothing of one before is owed.
                  feed.owed = null;
                  return current.screencast({ tab: feed.ref, ...size });
                }),
              ).pipe(
                Stream.tapError((error) => {
                  if (failing) return Effect.void;
                  failing = true;
                  // The reason only: a host's detail may name the page's address.
                  return Effect.logWarning("A tab's screencast failed", { reason: error.reason });
                }),
                Stream.catchIf(
                  (error) => !passing(error),
                  () => Stream.empty,
                ),
                Stream.retry(SCREENCAST_RETRY),
                Stream.tap(() =>
                  Effect.sync(() => {
                    failing = false;
                  }),
                ),
                Stream.mapEffect((frame) => received(feed, current, frame)),
                Stream.catchCause(() => Stream.empty),
              );
            },
          }),
        ),
        Stream.runDrain,
      );

    /** Who acts on the tab, and its dialog, for every socket as it changes. */
    const control = (feed: Feed) =>
      feed.watched.tab.pipe(
        Stream.runForEach((tab) =>
          feed.lock.withPermits(1)(
            Effect.gen(function* () {
              feed.tab = tab;
              feed.generation = (yield* feed.watched.control.state).epoch;
              yield* sendAll(feed, (viewer) => controlFrame(feed, viewer.deviceId));
            }),
          ),
        ),
      );

    /** Where bots point on the tab as they act. */
    const cursors = (feed: Feed) =>
      browser.pointers.pipe(
        Stream.filter((pointer) => pointer.tab === feed.ref),
        Stream.runForEach((pointer) =>
          feed.lock.withPermits(1)(
            sendAll(feed, () => ({
              type: "cursor",
              action: pointer.action,
              x: pointer.x,
              y: pointer.y,
              ...(pointer.botId === null ? {} : { botId: pointer.botId }),
            })),
          ),
        ),
      );

    /** The feed of `ref`, opened for its first socket; none once the tab is gone. Under `feedLock`. */
    const feedOf = Effect.fnUntraced(function* (ref: BrowserTabRef, size: ViewSize) {
      const existing = feeds.get(ref);
      if (existing !== undefined) return Option.some(existing);
      const scope = yield* Scope.make();
      const watched = yield* browser.watch(ref).pipe(Scope.provide(scope));
      if (Option.isNone(watched)) {
        yield* Scope.close(scope, Exit.void);
        return Option.none<Feed>();
      }
      const feed: Feed = {
        ref,
        watched: watched.value,
        scope,
        lock: yield* Semaphore.make(1),
        viewers: new Set(),
        host: Option.none(),
        latest: null,
        owed: null,
        viewport: null,
        tab: null,
        generation: 0,
        nextSeq: 0,
      };
      feeds.set(ref, feed);
      const background = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.forkIn(Effect.ignore(effect), scope);
      yield* background(screencast(feed, size));
      yield* background(control(feed));
      yield* background(cursors(feed));
      yield* background(
        feed.watched.closed.pipe(
          Effect.andThen(
            // The sockets on the tab when it closes, not when the feed opened.
            feed.lock.withPermits(1)(
              Effect.suspend(() =>
                Effect.forEach(
                  [...feed.viewers],
                  (viewer) => Deferred.succeed(viewer.ended, GONE),
                  { discard: true },
                ),
              ),
            ),
          ),
        ),
      );
      return Option.some(feed);
    });

    /** The socket left: the feed closes with its last socket. */
    const leave = (feed: Feed, viewer: Viewer) =>
      feedLock.withPermits(1)(
        Effect.gen(function* () {
          const last = yield* feed.lock.withPermits(1)(
            Effect.gen(function* () {
              feed.viewers.delete(viewer);
              // A picture it never drew is not waited on.
              const unacked = viewer.inFlight ?? viewer.pending;
              if (unacked !== null && feed.viewers.size === 0) yield* settle(feed, unacked);
              return feed.viewers.size === 0;
            }),
          );
          if (!last || feeds.get(feed.ref) !== feed) return;
          feeds.delete(feed.ref);
          yield* Scope.close(feed.scope, Exit.void);
        }),
      );

    /** Joins the feed, in place of the device's socket before it on the tab. */
    const join = (feed: Feed, viewer: Viewer) =>
      feed.lock.withPermits(1)(
        Effect.gen(function* () {
          for (const other of feed.viewers) {
            if (other.deviceId === viewer.deviceId) yield* Deferred.succeed(other.ended, REPLACED);
          }
          feed.viewers.add(viewer);
          if (feed.viewport !== null) {
            yield* sendTo(viewer, { type: "viewport", ...feed.viewport });
          }
          const frame = controlFrame(feed, viewer.deviceId);
          if (frame !== null) yield* sendTo(viewer, frame);
          if (feed.latest !== null) yield* sendPicture(viewer, feed.latest);
        }),
      );

    /** Tells a socket its input was not applied: the tab has no host. */
    const refuse = (feed: Feed, viewer: Viewer) =>
      // A desktop's tab with no host waits for its app; any other runs nowhere.
      sendTo(viewer, {
        type: "refused",
        reason: feed.tab?.where.kind === "desktop" ? "away" : "parked",
      });

    /**
     * A person's input to the page: applied only once it holds the tab for
     * them. With no host to take it, refused, saying why, and holding nothing.
     */
    const used = Effect.fnUntraced(function* (
      feed: Feed,
      viewer: Viewer,
      apply: (host: PageHost) => Effect.Effect<unknown>,
    ) {
      if (Option.isNone(feed.host)) return yield* refuse(feed, viewer);
      if (!(yield* browser.personUsed(feed.ref, viewer.deviceId))) return;
      // Their input takes the tab at once, and reaches the page once a fill's typing ended.
      yield* feed.watched.control.afterFill;
      // Read again: the host may have gone while the input waited.
      const host = feed.host;
      if (Option.isNone(host)) return yield* refuse(feed, viewer);
      yield* apply(host.value);
    });

    /** Whether a person on another device holds the tab now. */
    const heldElsewhere = (feed: Feed, viewer: Viewer) =>
      Effect.map(
        feed.watched.control.state,
        ({ holder }) => holder?.kind === "person" && holder.device !== viewer.deviceId,
      );

    /** One message from the client. */
    const receive = (feed: Feed, viewer: Viewer, frame: BrowserClientFrame) => {
      const tab = feed.ref;
      switch (frame.type) {
        case "pong":
          return Effect.void;
        case "ack":
          return feed.lock.withPermits(1)(
            Effect.gen(function* () {
              const drawn = viewer.inFlight;
              if (drawn === null) return;
              viewer.inFlight = null;
              yield* settle(feed, drawn);
              const next = viewer.pending;
              viewer.pending = null;
              if (next !== null) yield* sendPicture(viewer, next);
            }),
          );
        case "take":
          return feed.watched.control.waitForMe(viewer.deviceId);
        case "release":
          return feed.watched.control.release(viewer.deviceId, frame.idle === true);
        case "pointer":
          // Moving the pointer is no use of the page: it hovers for whoever
          // holds the tab, unless that is a person on another device.
          if (frame.action === "move") {
            return Effect.gen(function* () {
              if (yield* heldElsewhere(feed, viewer)) return;
              const host = feed.host;
              if (Option.isNone(host)) return;
              yield* host.value.input({ tab, input: frame }).pipe(Effect.ignore);
            });
          }
          return used(feed, viewer, (host) =>
            host.input({ tab, input: frame }).pipe(Effect.ignore),
          );
        case "wheel":
        case "key":
        case "text":
          return used(feed, viewer, (host) =>
            host.input({ tab, input: frame }).pipe(Effect.ignore),
          );
        case "navigate":
        case "back":
        case "forward":
        case "reload": {
          const to =
            frame.type === "navigate"
              ? { kind: "url" as const, url: frame.url }
              : { kind: frame.type };
          // In the background: the socket keeps taking input while the page loads.
          return used(feed, viewer, (host) =>
            Effect.forkIn(host.navigate({ tab, to }).pipe(Effect.ignore), feed.scope),
          );
        }
        case "dialog":
          return used(feed, viewer, (host) =>
            host
              .dialog({
                tab,
                accept: frame.accept,
                ...(frame.promptText === undefined ? {} : { promptText: frame.promptText }),
              })
              .pipe(Effect.ignore),
          );
        case "probe":
          return Option.match(feed.host, {
            onNone: () => Effect.void,
            onSome: (host) =>
              host.probe({ tab, x: frame.x, y: frame.y }).pipe(
                Effect.flatMap(({ editable }) =>
                  sendTo(viewer, { type: "probe", x: frame.x, y: frame.y, editable }),
                ),
                Effect.ignore,
              ),
          });
      }
    };

    /** Serves one socket on its feed until it closes, goes silent, or is ended. */
    const serve = Effect.fnUntraced(function* (feed: Feed, viewer: Viewer) {
      const link = viewer.link;
      let heardAt = yield* Clock.currentTimeMillis;
      const listen = link.incoming.pipe(
        Stream.runForEach((frame) =>
          Clock.currentTimeMillis.pipe(
            Effect.tap((now) =>
              Effect.sync(() => {
                heardAt = now;
              }),
            ),
            Effect.andThen(receive(feed, viewer, frame)),
          ),
        ),
        Effect.as(null),
      );
      const keepAlive = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(PING_EVERY);
          const now = yield* Clock.currentTimeMillis;
          if (now - heardAt >= Duration.toMillis(SILENT_LIMIT)) return null;
          yield* link.send({ type: "ping" }).pipe(Effect.ignore);
        }
      });
      const revoked = auth.revoked(viewer.deviceId).pipe(Effect.as(REVOKED));
      // The socket's request ends with the socket: it may be interrupted
      // here, and the feed must still learn the socket left.
      const closing = yield* Effect.raceAll([
        listen,
        keepAlive,
        revoked,
        Deferred.await(viewer.ended),
      ]);
      if (closing !== null) yield* closeAs(link, closing);
    });

    const connect = Effect.fn("BrowserViewers.connect")(function* (input: {
      readonly deviceId: DeviceId;
      readonly ref: BrowserTabRef;
      readonly size: ViewSize;
      readonly link: ClientLink;
    }) {
      const viewer: Viewer = {
        deviceId: input.deviceId,
        link: input.link,
        ended: yield* Deferred.make<Closing | null>(),
        inFlight: null,
        pending: null,
      };
      // Found or opened, and joined, in one step: the last socket's leave
      // cannot close the feed between the two.
      const entered = feedLock.withPermits(1)(
        Effect.gen(function* () {
          const feed = yield* feedOf(input.ref, input.size);
          if (Option.isSome(feed)) yield* join(feed.value, viewer);
          return feed;
        }),
      );
      yield* Effect.acquireUseRelease(
        entered,
        (feed) => (Option.isNone(feed) ? closeAs(input.link, GONE) : serve(feed.value, viewer)),
        (feed) => (Option.isNone(feed) ? Effect.void : leave(feed.value, viewer)),
      );
    });

    return BrowserViewers.of({ connect });
  }),
);
