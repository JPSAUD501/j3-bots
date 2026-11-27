// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ConnectorNotice,
  type BotId,
  type DeviceId,
  type Entry,
  type EntryTarget,
  type Notification,
  type NotificationKind,
  type NotificationSettings,
  PREVIEW_LENGTH,
  type RoutineNotice,
  type RoutineRunEntry,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Devices } from "../devices/Devices.ts";
import { cut, previewOf } from "../entries/preview.ts";
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
 * What kind of notification an entry makes, if any: a bot's message, or a
 * card that waits on the operator. The operator's own entries, a turn's work,
 * notices (quiet lines by design), routine changes (which come with the bot's
 * own words) and teammate messages (the bots' business: a bot that needs the
 * operator says so) never notify.
 *
 * Every notification follows from an entry, so a routine run that ends
 * silently, which adds none, notifies nothing; one that speaks notifies as
 * any message does.
 */
const kindOf = (
  entry: Entry,
): {
  readonly kind: NotificationKind;
  readonly botId: BotId;
  readonly routine: RoutineNotice | null;
} | null => {
  if (entry.author._tag !== "bot") return null;
  if (entry._tag === "routine-run") {
    const notice = routineNoticeOf(entry);
    return notice === null ? null : { ...notice, botId: entry.author.botId };
  }
  const kind = notificationKindOf(entry._tag);
  return kind === null ? null : { kind, botId: entry.author.botId, routine: null };
};

/**
 * Whether a run's card needs the operator (decision 0080): the run waits for
 * their yes, or failed at a step other than by a Stop, which they gave. Both
 * are theirs to decide, as a question is. A card that changes otherwise
 * notifies nothing.
 */
const routineNoticeOf = (
  entry: RoutineRunEntry,
): { readonly kind: NotificationKind; readonly routine: RoutineNotice } | null => {
  const steps = entry.run.steps ?? [];
  if (entry.run.status === "running" && steps.some((step) => step.state === "waiting")) {
    return { kind: "question", routine: { name: entry.name, reason: "yes", stepBotId: null } };
  }
  const failed = steps.find((step) => step.state === "failed");
  if (entry.run.status !== "failed" || failed === undefined || failed.failure === "stopped") {
    return null;
  }
  return {
    kind: "question",
    routine: {
      name: entry.name,
      reason: "failed",
      stepBotId: failed.step._tag === "bot" ? failed.step.botId : null,
    },
  };
};

/**
 * The notification an entry of this kind makes when it notifies, which names
 * the Android channel a push shows in: its own kind, or `connector` for either
 * connector card. Null for a kind that never notifies. A push read back from
 * its delivery takes its channel from here too, from the entry it is about.
 */
export const notificationKindOf = (kind: Entry["_tag"]): NotificationKind | null => {
  switch (kind) {
    case "message":
    case "question":
    case "approval":
    case "secret-request":
    case "browser-help":
      return kind;
    // A bot's ask for a secret shows where the engine's secret requests do,
    // Android's channel for them included.
    case "secret-ask":
      return "secret-request";
    // The operator's yes before a bot adds a connector notifies as approvals do.
    case "connector-ask":
      return "approval";
    case "connector-auth":
    case "connector-input":
      return "connector";
    // A bot's message to a teammate shows in both conversations and notifies no one.
    case "handoff":
    case "work-fold":
    case "notice":
    case "routine-change":
      return null;
    // A run's card notifies only when it needs the operator (`routineNoticeOf`),
    // as a question.
    case "routine-run":
      return "question";
  }
};

/** Which connector card a `connector` notification is about; null for any other entry. */
const connectorCard = (entry: Entry): ConnectorNotice | null => {
  switch (entry._tag) {
    case "connector-auth":
      return "sign-in";
    case "connector-input":
      return "input";
    default:
      return null;
  }
};

/**
 * The entry's first line, when the operator allows previews and it has one.
 * A browser help card's note is the bot's own words, which could quote a
 * sign-in link or a code onto a lock screen: its preview is `browserHelpOf`.
 */
const previewText = (entry: Entry, settings: NotificationSettings): string | null => {
  if (!settings.previews || entry._tag === "browser-help") return null;
  // A run's card: the question its yes asks, never a step's own words otherwise.
  if (entry._tag === "routine-run") {
    const asked = entry.run.steps?.find((step) => step.state === "waiting")?.ask?.question;
    const line = cut((asked?.split("\n")[0] ?? "").trim(), PREVIEW_LENGTH);
    return line === "" ? null : line;
  }
  const line = (previewOf(entry, null).text.split("\n")[0] ?? "").trim();
  return line === "" ? null : line;
};

/** A browser help card's preview, in fixed words: why the bot asks, and the site. */
const browserHelpOf = (entry: Entry, settings: NotificationSettings) =>
  settings.previews && entry._tag === "browser-help"
    ? { reason: entry.reason, site: entry.site }
    : null;

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
          connector: connectorCard(entry),
          browserHelp: browserHelpOf(entry, notifications),
          ...(made.routine === null ? {} : { routine: made.routine }),
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
