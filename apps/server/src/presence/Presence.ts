// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entry, EntryTarget, Notification } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** One connected socket, from its handlers' start to their end. */
export interface Viewer {
  /** What the operator is looking at on this socket now. */
  readonly view: (target: EntryTarget | null) => Effect.Effect<void>;
  /** This socket's notifications, live from now on. */
  readonly notifications: Stream.Stream<Notification>;
}

const sameTarget = (a: EntryTarget, b: EntryTarget): boolean =>
  a._tag === "conversation"
    ? b._tag === "conversation" && a.botId === b.botId
    : b._tag === "room" && a.roomId === b.roomId;

/** Why an entry is worth the operator's attention, if it is. */
const reasonOf = (entry: Entry): Notification["reason"] | null => {
  if (entry.author._tag === "operator") return null;
  switch (entry._tag) {
    case "question":
    case "approval":
    case "secret-request":
      return "waiting";
    // A turn's work is shown as it happens, never announced.
    case "work-fold":
      return null;
    default:
      return "entry";
  }
};

/**
 * What each connected client has in view, and the notifications that follow
 * from it (`docs/architecture/server.md`, Notifications): an entry the
 * operator did not write, added where no connected client is looking, or a
 * card that waits on them. Kept in memory: a socket's view ends with it.
 */
export class Presence extends Context.Service<
  Presence,
  {
    /** A socket's place, for as long as the scope lives. */
    readonly connect: Effect.Effect<Viewer, never, Scope.Scope>;
    /** Tells every socket about an entry just committed, unless someone has its target in view. */
    readonly entryAdded: (target: EntryTarget, entry: Entry) => Effect.Effect<void>;
  }
>()("@j3-bots/server/presence/Presence") {}

export const layer = Layer.sync(Presence, () => {
  const sockets = new Map<
    object,
    { target: EntryTarget | null; readonly pubsub: PubSub.PubSub<Notification> }
  >();

  const connect = Effect.gen(function* () {
    const key = {};
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<Notification>(), PubSub.shutdown);
    const socket: { target: EntryTarget | null; readonly pubsub: PubSub.PubSub<Notification> } = {
      target: null,
      pubsub,
    };
    sockets.set(key, socket);
    yield* Effect.addFinalizer(() => Effect.sync(() => sockets.delete(key)));
    return {
      view: (target) =>
        Effect.sync(() => {
          socket.target = target;
        }),
      notifications: Stream.fromPubSub(pubsub),
    } satisfies Viewer;
  });

  const entryAdded = Effect.fn("Presence.entryAdded")(function* (
    target: EntryTarget,
    entry: Entry,
  ) {
    const reason = reasonOf(entry);
    if (reason === null) return;
    const watched = [...sockets.values()].some(
      (socket) => socket.target !== null && sameTarget(socket.target, target),
    );
    if (watched) return;
    const notification: Notification = { target, entryId: entry.id, reason };
    for (const socket of sockets.values()) yield* PubSub.publish(socket.pubsub, notification);
  });

  return Presence.of({ connect, entryAdded });
});
