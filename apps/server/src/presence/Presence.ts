// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotId,
  Entry,
  EntryTarget,
  Notification,
  NotificationKind,
  NotificationSettings,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { previewOf } from "../entries/preview.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";

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

/**
 * What kind of notification an entry makes, if any: a bot's message, an
 * urgent message to a teammate, or a card that waits on the operator. The
 * operator's own entries, a turn's work, notices (quiet lines by design) and
 * routine changes (which come with the bot's own words) never notify; nor
 * does a teammate message that is not urgent.
 *
 * Every notification follows from an entry, so a routine run that ends
 * silently, which adds none, notifies nothing; one that speaks notifies as
 * any message does.
 */
const kindOf = (
  entry: Entry,
): { readonly kind: NotificationKind; readonly botId: BotId } | null => {
  if (entry.author._tag !== "bot") return null;
  const { botId } = entry.author;
  switch (entry._tag) {
    case "message":
    case "question":
    case "approval":
    case "secret-request":
      return { kind: entry._tag, botId };
    case "handoff":
      return entry.urgent ? { kind: entry._tag, botId } : null;
    case "work-fold":
    case "notice":
    case "routine-change":
      return null;
  }
};

/** The entry's first line, when the operator allows previews and it has one. */
const previewText = (entry: Entry, settings: NotificationSettings): string | null => {
  if (!settings.previews) return null;
  const line = (previewOf(entry).text.split("\n")[0] ?? "").trim();
  return line === "" ? null : line;
};

interface Socket {
  target: EntryTarget | null;
  readonly pubsub: PubSub.PubSub<Notification>;
}

/**
 * What each connected client has in view, and the notifications that follow
 * from it (`docs/architecture/server.md`, Notifications): an entry worth the
 * operator's attention, added where no connected client has it in view, sent
 * to every socket while the operator has notifications on. Kept in memory: a
 * socket's view ends with it.
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

export const layer = Layer.effect(
  Presence,
  Effect.gen(function* () {
    const settings = yield* SettingsStore;
    const sockets = new Map<object, Socket>();

    const connect = Effect.gen(function* () {
      const key = {};
      const pubsub = yield* Effect.acquireRelease(
        PubSub.unbounded<Notification>(),
        PubSub.shutdown,
      );
      const socket: Socket = { target: null, pubsub };
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
      const made = kindOf(entry);
      if (made === null || sockets.size === 0) return;
      const watched = [...sockets.values()].some(
        (socket) => socket.target !== null && sameTarget(socket.target, target),
      );
      if (watched) return;
      const { notifications } = yield* settings.get;
      if (!notifications.enabled) return;
      const notification: Notification = {
        target,
        entryId: entry.id,
        botId: made.botId,
        kind: made.kind,
        preview: previewText(entry, notifications),
      };
      for (const socket of sockets.values()) yield* PubSub.publish(socket.pubsub, notification);
    });

    return Presence.of({ connect, entryAdded });
  }),
);
