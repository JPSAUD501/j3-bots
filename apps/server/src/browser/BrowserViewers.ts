// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BROWSER_CLOSE_CODES,
  type BrowserClientFrame,
  type BrowserController,
  type BrowserServerFrame,
  type BrowserTabRef,
  DEFAULT_BROWSER_VIEW,
  type DeviceId,
} from "@j3-bots/contracts";
import {
  BrowserBridge,
  type BrowserViewer,
  type EngineTabId,
  ViewerClosed,
  type ViewerController,
  type ViewerOutput,
} from "@j3-bots/engine-t3";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { BrowserTabs } from "./BrowserTabs.ts";

// What the server does between a client's media socket and the engine's view
// of one tab. Each device has at most one viewer per tab, which a socket of
// that device attaches to: the device's next socket on the tab takes the
// viewer over, control included. Pictures are held in memory only, never
// written anywhere, logged or kept once the viewer closes: at most the one
// the client is drawing, the newest one waiting behind it, and the last one
// the client drew, for a socket that takes the viewer over.

/** How long a device keeps a tab it holds after its socket drops. */
export const CONTROL_GRACE = Duration.seconds(60);
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
     * socket closes, another socket of the device takes its place, the tab
     * closes, or the device is revoked. The engine is asked for the next
     * picture only once the client acknowledged the last.
     */
    readonly connect: (input: {
      readonly deviceId: DeviceId;
      readonly ref: BrowserTabRef;
      readonly size: ViewSize;
      readonly link: ClientLink;
    }) => Effect.Effect<void>;
    /**
     * Gives `tabs` back to the bot from every device that holds one, also a
     * device in its grace after its socket dropped. The engine says so on
     * each viewer's next `control`, which `BrowserTabs.held` then follows.
     */
    readonly release: (tabs: ReadonlyArray<EngineTabId>) => Effect.Effect<void>;
  }
>()("@j3-bots/server/browser/BrowserViewers") {}

/** A picture, and whether the engine still waits for its acknowledgement. */
interface Picture {
  readonly jpeg: Uint8Array;
  readonly owed: boolean;
}

/** A socket attached to a viewer, and the signal that detaches it. */
interface Attached {
  readonly link: ClientLink;
  readonly detached: Deferred.Deferred<void>;
}

/** How a viewer ended, for its socket: the last frame it gets and the code it closes with. */
interface Closing {
  readonly frame: BrowserServerFrame | null;
  readonly code: number;
  readonly reason: string;
  /**
   * The device may not view the tab again, as once it is revoked: a socket
   * that meets this ending as it attaches closes with it, and opens nothing.
   */
  readonly final: boolean;
}

interface Entry {
  readonly key: string;
  readonly deviceId: DeviceId;
  readonly tab: EngineTabId;
  readonly viewer: BrowserViewer;
  readonly scope: Scope.Closeable;
  readonly lock: Semaphore.Semaphore;
  attached: Attached | null;
  /** Sent to the client, not acknowledged yet. */
  inFlight: Picture | null;
  /** The newest picture, waiting for the one in flight. */
  pending: Picture | null;
  /** The last picture the client acknowledged. */
  shown: Uint8Array | null;
  viewport: BrowserServerFrame | null;
  control: Extract<ViewerOutput, { readonly _tag: "control" }> | null;
  /** Whether this device holds the tab, as the engine last said. */
  holds: boolean;
  /** How the viewer ended, once it has. */
  ended: Closing | null;
  fibers: Set<Fiber.Fiber<unknown, unknown>>;
  grace: Fiber.Fiber<unknown, unknown> | null;
}

/** The sockets of one device on one tab, waiting their turn to attach. */
interface Gate {
  readonly lock: Semaphore.Semaphore;
  users: number;
}

const keyOf = (deviceId: DeviceId, tab: EngineTabId) => `${deviceId}\u0000${tab}`;

/** How many times a socket opens the device's viewer again when it ends as the socket attaches. */
const REOPENS = 1;

const CONTROLLERS: Record<ViewerController, BrowserController> = {
  bot: "bot",
  "this-viewer": "you",
  "another-viewer": "another-device",
  nobody: "nobody",
};

const controlFrame = (
  control: Extract<ViewerOutput, { readonly _tag: "control" }>,
): BrowserServerFrame => ({
  type: "control",
  controller: CONTROLLERS[control.controller],
  generation: control.generation,
  dialog: control.dialog,
});

/** How a socket is closed when the engine's viewer ends for `closed`. */
const ending = (closed: ViewerClosed): Closing => {
  switch (closed.reason) {
    case "gone":
      return { frame: { type: "gone" }, code: 1000, reason: "gone", final: false };
    case "setup-needed":
      return {
        frame: { type: "setup-needed", need: closed.need ?? "libraries" },
        code: 1000,
        reason: "setup-needed",
        final: false,
      };
    case "reconnect":
      return {
        frame: null,
        code: BROWSER_CLOSE_CODES.reconnect,
        reason: "reconnect",
        final: false,
      };
    case "lost":
      return {
        frame: null,
        code: BROWSER_CLOSE_CODES.unavailable,
        reason: "unavailable",
        final: false,
      };
  }
};

const REVOKED: Closing = {
  frame: null,
  code: BROWSER_CLOSE_CODES.invalid,
  reason: "revoked",
  final: true,
};

/** Closes `link` as `closing` says. */
const closeAs = Effect.fnUntraced(function* (link: ClientLink, closing: Closing) {
  if (closing.frame !== null) yield* link.send(closing.frame).pipe(Effect.ignore);
  yield* link.close(closing.code, closing.reason);
});

export const layer = Layer.effect(
  BrowserViewers,
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge;
    const tabs = yield* BrowserTabs;
    const auth = yield* DeviceAuth;
    const serverScope = yield* Effect.scope;
    const entries = new Map<string, Entry>();
    const gates = new Map<string, Gate>();

    const background = <A, E>(effect: Effect.Effect<A, E>) => Effect.forkIn(effect, serverScope);

    /** Sends to the attached socket; a socket that cannot take it is detached. */
    const sendTo = (entry: Entry, message: Uint8Array | BrowserServerFrame) => {
      const attached = entry.attached;
      if (attached === null) return Effect.void;
      return attached.link
        .send(message)
        .pipe(Effect.catch(() => Deferred.succeed(attached.detached, undefined)));
    };

    /** Sends the newest picture if nothing is in flight. */
    const sendPending = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.attached === null || entry.inFlight !== null || entry.pending === null) return;
      const picture = entry.pending;
      entry.pending = null;
      entry.inFlight = picture;
      yield* sendTo(entry, picture.jpeg);
    });

    /** Takes back the picture in flight to a socket that is leaving, so the next one gets it. */
    const recall = Effect.fnUntraced(function* (entry: Entry) {
      const picture = entry.inFlight;
      entry.inFlight = null;
      if (picture === null) return;
      if (entry.pending === null) entry.pending = picture;
      else if (picture.owed) yield* entry.viewer.ack;
    });

    /**
     * Ends the viewer: its socket gets `closing`, the engine's viewer closes,
     * which gives the tab back, and the device holds the tab no more. Runs
     * with the entry's lock held, and is never interrupted halfway.
     */
    const endLocked = (entry: Entry, closing: Closing) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (entry.ended !== null) return;
          entry.ended = closing;
          if (entries.get(entry.key) === entry) entries.delete(entry.key);
          const attached = entry.attached;
          entry.attached = null;
          if (attached !== null) {
            yield* closeAs(attached.link, closing);
            yield* Deferred.succeed(attached.detached, undefined);
          }
          entry.inFlight = null;
          entry.pending = null;
          entry.shown = null;
          yield* tabs.holding(entry.tab, entry.deviceId, false);
          // Interrupted from outside, so a fiber that ends its own entry is not waited on.
          for (const fiber of entry.fibers) yield* background(Fiber.interrupt(fiber));
          yield* Scope.close(entry.scope, Exit.void);
        }),
      );

    const end = (entry: Entry, closing: Closing) =>
      entry.lock.withPermits(1)(endLocked(entry, closing));

    /** What the engine's viewer sends, for as long as it is open. */
    const pump = (entry: Entry) =>
      entry.viewer.output.pipe(
        Stream.runForEach((output) =>
          entry.lock.withPermits(1)(
            Effect.gen(function* () {
              if (entry.ended !== null) return;
              switch (output._tag) {
                case "frame": {
                  const picture = { jpeg: output.jpeg, owed: true };
                  if (entry.attached !== null && entry.inFlight === null) {
                    entry.inFlight = picture;
                    yield* sendTo(entry, picture.jpeg);
                    return;
                  }
                  // Only the newest waits: the one it replaces is acknowledged unsent.
                  if (entry.pending?.owed === true) yield* entry.viewer.ack;
                  entry.pending = picture;
                  return;
                }
                case "viewport": {
                  const frame: BrowserServerFrame = {
                    type: "viewport",
                    width: output.width,
                    height: output.height,
                  };
                  entry.viewport = frame;
                  yield* sendTo(entry, frame);
                  return;
                }
                case "control": {
                  entry.control = output;
                  entry.holds = output.controller === "this-viewer";
                  yield* tabs.holding(entry.tab, entry.deviceId, entry.holds);
                  yield* sendTo(entry, controlFrame(output));
                  return;
                }
                case "probe":
                  yield* sendTo(entry, {
                    type: "probe",
                    x: output.x,
                    y: output.y,
                    editable: output.editable,
                  });
                  return;
                case "cursor":
                  yield* sendTo(entry, {
                    type: "cursor",
                    action: output.action,
                    x: output.x,
                    y: output.y,
                  });
                  return;
              }
            }),
          ),
        ),
        Effect.flatMap(() => end(entry, ending(new ViewerClosed({ reason: "lost" })))),
        Effect.catch((closed) => end(entry, ending(closed))),
      );

    /** Opens the device's viewer of `tab`. */
    const open = Effect.fnUntraced(function* (
      deviceId: DeviceId,
      tab: EngineTabId,
      size: ViewSize,
    ) {
      const scope = yield* Scope.make();
      const viewer = yield* bridge.openViewer({ tab, ...size }).pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      const entry: Entry = {
        key: keyOf(deviceId, tab),
        deviceId,
        tab,
        viewer,
        scope,
        lock: yield* Semaphore.make(1),
        attached: null,
        inFlight: null,
        pending: null,
        shown: null,
        viewport: null,
        control: null,
        holds: false,
        ended: null,
        fibers: new Set(),
        grace: null,
      };
      entries.set(entry.key, entry);
      entry.fibers.add(yield* background(pump(entry)));
      // Revoking the device closes its viewers at once, held tabs included.
      entry.fibers.add(
        yield* background(auth.revoked(deviceId).pipe(Effect.andThen(end(entry, REVOKED)))),
      );
      return entry;
    });

    /** Attaches `link` to the entry, in place of any socket before it; how it ended, if it has. */
    const attach = (entry: Entry, link: ClientLink) =>
      entry.lock.withPermits(1)(
        Effect.gen(function* () {
          if (entry.ended !== null) return Result.fail(entry.ended);
          const previous = entry.attached;
          if (previous !== null) {
            yield* recall(entry);
            entry.attached = null;
            yield* previous.link.close(BROWSER_CLOSE_CODES.replaced, "replaced");
            yield* Deferred.succeed(previous.detached, undefined);
          }
          if (entry.grace !== null) {
            const grace = entry.grace;
            entry.grace = null;
            entry.fibers.delete(grace);
            yield* background(Fiber.interrupt(grace));
          }
          const attached: Attached = { link, detached: yield* Deferred.make<void>() };
          entry.attached = attached;
          if (entry.viewport !== null) yield* sendTo(entry, entry.viewport);
          if (entry.control !== null) yield* sendTo(entry, controlFrame(entry.control));
          if (entry.pending === null && entry.shown !== null) {
            entry.pending = { jpeg: entry.shown, owed: false };
          }
          yield* sendPending(entry);
          return Result.succeed(attached);
        }),
      );

    /** The socket left: a device that holds the tab keeps it for `CONTROL_GRACE`. */
    const detach = (entry: Entry, attached: Attached) =>
      entry.lock.withPermits(1)(
        Effect.gen(function* () {
          if (entry.ended !== null || entry.attached !== attached) return;
          entry.attached = null;
          yield* recall(entry);
          if (!entry.holds) {
            return yield* endLocked(entry, {
              frame: null,
              code: 1000,
              reason: "closed",
              final: false,
            });
          }
          const grace = yield* background(
            Effect.sleep(CONTROL_GRACE).pipe(
              Effect.andThen(
                end(entry, { frame: null, code: 1000, reason: "grace", final: false }),
              ),
            ),
          );
          entry.grace = grace;
          entry.fibers.add(grace);
        }),
      );

    /** One message from the client. */
    const receive = (entry: Entry, attached: Attached, frame: BrowserClientFrame) => {
      switch (frame.type) {
        case "pong":
          return Effect.void;
        case "ack":
          return entry.lock.withPermits(1)(
            Effect.gen(function* () {
              if (entry.ended !== null || entry.attached !== attached || entry.inFlight === null) {
                return;
              }
              const picture = entry.inFlight;
              entry.inFlight = null;
              entry.shown = picture.jpeg;
              if (picture.owed) yield* entry.viewer.ack;
              yield* sendPending(entry);
            }),
          );
        default:
          return entry.attached === attached ? entry.viewer.send(frame) : Effect.void;
      }
    };

    /**
     * Runs `effect` for one socket of a device on a tab while no other socket
     * of that device on that tab runs it, in the order the sockets came. So the
     * device gets one viewer of the tab, and the socket that came last is the
     * one left attached.
     */
    const inTurn = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const gate = gates.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
          gate.users++;
          gates.set(key, gate);
          return gate;
        }),
        (gate) => gate.lock.withPermits(1)(effect),
        (gate) =>
          Effect.sync(() => {
            gate.users--;
            if (gate.users === 0) gates.delete(key);
          }),
      );

    /** The device's viewer of `tab`, opened if it has none, with `link` attached to it. */
    const join = (deviceId: DeviceId, tab: EngineTabId, size: ViewSize, link: ClientLink) =>
      inTurn(
        keyOf(deviceId, tab),
        Effect.gen(function* () {
          const entry =
            entries.get(keyOf(deviceId, tab)) ??
            (yield* open(deviceId, tab, size).pipe(
              Effect.option,
              Effect.map(Option.getOrUndefined),
            ));
          if (entry === undefined) return { _tag: "unavailable" } as const;
          const attached = yield* attach(entry, link);
          return Result.isSuccess(attached)
            ? ({ _tag: "attached", entry, attached: attached.success } as const)
            : ({ _tag: "ended", closing: attached.failure } as const);
        }),
      );

    /** Serves one attached socket until it closes, goes silent or is detached. */
    const serve = Effect.fnUntraced(function* (current: Entry, socket: Attached) {
      const link = socket.link;

      let heardAt = yield* Clock.currentTimeMillis;
      const listen = link.incoming.pipe(
        Stream.runForEach((frame) =>
          Clock.currentTimeMillis.pipe(
            Effect.tap((now) =>
              Effect.sync(() => {
                heardAt = now;
              }),
            ),
            Effect.andThen(receive(current, socket, frame)),
          ),
        ),
      );
      const keepAlive = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(PING_EVERY);
          const now = yield* Clock.currentTimeMillis;
          if (now - heardAt >= Duration.toMillis(SILENT_LIMIT)) return;
          yield* link.send({ type: "ping" }).pipe(Effect.ignore);
        }
      });
      // The socket's request ends with the socket: it may be interrupted
      // here, and the viewer must still learn the socket left.
      yield* Effect.raceAll([listen, keepAlive, Deferred.await(socket.detached)]).pipe(
        Effect.ensuring(detach(current, socket)),
      );
    });

    const connect = Effect.fn("BrowserViewers.connect")(function* (input: {
      readonly deviceId: DeviceId;
      readonly ref: BrowserTabRef;
      readonly size: ViewSize;
      readonly link: ClientLink;
    }) {
      const { deviceId, link } = input;
      // A viewer that ends as this socket attaches is opened again, once, if the
      // tab is still there and the device may still view it.
      for (let attempt = 0; ; attempt++) {
        const tab = yield* tabs.resolve(input.ref);
        if (Option.isNone(tab)) {
          yield* link.send({ type: "gone" }).pipe(Effect.ignore);
          return yield* link.close(1000, "gone");
        }
        const joined = yield* join(deviceId, tab.value, input.size, link);
        if (joined._tag === "attached") return yield* serve(joined.entry, joined.attached);
        if (joined._tag === "ended" && joined.closing.final) {
          return yield* closeAs(link, joined.closing);
        }
        if (joined._tag === "unavailable" || attempt === REOPENS) {
          return yield* link.close(BROWSER_CLOSE_CODES.unavailable, "unavailable");
        }
      }
    });

    const release = (tabs: ReadonlyArray<EngineTabId>) => {
      const wanted = new Set(tabs);
      return Effect.forEach(
        [...entries.values()].filter((entry) => wanted.has(entry.tab)),
        (entry) =>
          entry.lock.withPermits(1)(
            entry.ended !== null || !entry.holds
              ? Effect.void
              : entry.viewer.send({ type: "release" }),
          ),
        { discard: true },
      );
    };

    return BrowserViewers.of({ connect, release });
  }),
);
