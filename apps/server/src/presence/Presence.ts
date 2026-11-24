// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotId,
  DeviceId,
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
import { Devices } from "../devices/Devices.ts";
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
    case "browser-help":
      return { kind: entry._tag, botId };
    case "handoff":
      // One notification for an urgent message: the sender's card.
      return entry.urgent && entry.direction === "sent" ? { kind: entry._tag, botId } : null;
    case "work-fold":
    case "notice":
    case "routine-change":
      return null;
  }
};

/** The entry's first line, when the operator allows previews and it has one. */
const previewText = (entry: Entry, settings: NotificationSettings): string | null => {
  if (!settings.previews) return null;
  const line = (previewOf(entry, null).text.split("\n")[0] ?? "").trim();
  return line === "" ? null : line;
};

interface Socket {
  target: EntryTarget | null;
  readonly pubsub: PubSub.PubSub<Notification>;
}

/**
 * Who an entry's notification reaches, each device once, in the order the
 * devices were paired. Only devices paired and not revoked count.
 */
export interface Recipients {
  readonly notification: Notification;
  /** Devices with a socket open, told on each of their sockets now. */
  readonly live: ReadonlyArray<DeviceId>;
  /** Devices with no socket open that registered for push: the ones a push reaches. */
  readonly push: ReadonlyArray<DeviceId>;
}

/**
 * What each connected client has in view, and the notifications that follow
 * from it (`docs/architecture/server.md`, Notifications): an entry worth the
 * operator's attention, added where no connected client has it in view, while
 * the operator has notifications on, is told to every socket of a device that
 * has one open; a device with none is left to a push if it registered for
 * one. Kept in memory: a socket's view ends with it.
 */
export class Presence extends Context.Service<
  Presence,
  {
    /** A socket of the device, in place for as long as the scope lives. */
    readonly connect: (deviceId: DeviceId) => Effect.Effect<Viewer, never, Scope.Scope>;
    /**
     * Who would hear of the entry now, or `null` when nobody would. Its
     * reads go through the current transaction, so it can run in the one that
     * adds the entry.
     */
    readonly recipients: (target: EntryTarget, entry: Entry) => Effect.Effect<Recipients | null>;
    /**
     * Tells the live recipients of one `recipients` result on each socket
     * they still have open. A device that connected since is not told: it
     * was a device to push, and stays one, so no device is told both ways.
     * A live recipient whose sockets all closed since is told nothing, and
     * not pushed to either: as with any notification missed while
     * disconnected, the roster shows the entry unread.
     */
    readonly tell: (recipients: Recipients) => Effect.Effect<void>;
  }
>()("@j3-bots/server/presence/Presence") {}

export const layer = Layer.effect(
  Presence,
  Effect.gen(function* () {
    const settings = yield* SettingsStore;
    const devices = yield* Devices;
    /** Each device's open sockets; a device leaves when its last one closes. */
    const sockets = new Map<DeviceId, Set<Socket>>();

    const connect = Effect.fn("Presence.connect")(function* (deviceId: DeviceId) {
      const pubsub = yield* Effect.acquireRelease(
        PubSub.unbounded<Notification>(),
        PubSub.shutdown,
      );
      const socket: Socket = { target: null, pubsub };
      // One step that cannot be interrupted halfway: a socket in the map
      // always leaves it, or its device would count as live, and never be
      // pushed to, for good.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const own = sockets.get(deviceId) ?? new Set<Socket>();
          own.add(socket);
          sockets.set(deviceId, own);
        }),
        () =>
          Effect.sync(() => {
            const own = sockets.get(deviceId);
            if (own === undefined) return;
            own.delete(socket);
            if (own.size === 0) sockets.delete(deviceId);
          }),
      );
      return {
        view: (target) =>
          Effect.sync(() => {
            socket.target = target;
          }),
        notifications: Stream.fromPubSub(pubsub),
      } satisfies Viewer;
    });

    /** Whether a socket of `deviceId` has `target` in view. */
    const inView = (deviceId: DeviceId, target: EntryTarget): boolean => {
      for (const socket of sockets.get(deviceId) ?? []) {
        if (socket.target !== null && sameTarget(socket.target, target)) return true;
      }
      return false;
    };

    const recipients = Effect.fn("Presence.recipients")(function* (
      target: EntryTarget,
      entry: Entry,
    ) {
      const made = kindOf(entry);
      if (made === null) return null;
      const { notifications } = yield* settings.get;
      if (!notifications.enabled) return null;
      const paired = yield* devices.paired;
      // From here on, one synchronous step over the sockets as they are now:
      // what is in view and who has a socket open are read together. A
      // revoked device's socket, until it closes, counts for neither.
      if (paired.some(({ id }) => inView(id, target))) return null;
      return {
        notification: {
          target,
          entryId: entry.id,
          botId: made.botId,
          kind: made.kind,
          preview: previewText(entry, notifications),
        },
        live: paired.filter(({ id }) => sockets.has(id)).map(({ id }) => id),
        push: paired
          .filter(({ id, pushRegistered }) => pushRegistered && !sockets.has(id))
          .map(({ id }) => id),
      } satisfies Recipients;
    });

    const tell = Effect.fn("Presence.tell")(function* (told: Recipients) {
      for (const deviceId of told.live) {
        for (const socket of sockets.get(deviceId) ?? []) {
          yield* PubSub.publish(socket.pubsub, told.notification);
        }
      }
    });

    return Presence.of({ connect, recipients, tell });
  }),
);
