// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceId, EntryTarget, Notification } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Connection } from "../connection/Connection.ts";
import { targetKey } from "./Conversations.ts";

/** What the operator is looking at, and the pairing it was set under. */
interface View {
  readonly pairing: DeviceId | null;
  readonly target: EntryTarget | null;
}

const viewKey = (target: EntryTarget | null) => (target === null ? null : targetKey(target));

/**
 * What the operator is looking at, and what the server wants them to know
 * about the rest. The server notifies only about targets no connected client
 * has in view, so the view is sent again on every socket.
 *
 * Both belong to the pairing the window follows: a view set under one pairing
 * is never sent on a socket of another, which hears `null` until the window
 * sets its view again, and a notification that arrives on a socket of a
 * pairing the window no longer follows is dropped.
 */
export class Presence extends Context.Service<
  Presence,
  {
    /**
     * The conversation or room the operator has in view, or `null` when none
     * is: the window is hidden, in the background or not focused.
     */
    readonly setView: (target: EntryTarget | null) => Effect.Effect<void>;
    /** Notifications for this client to show, while connected. Missed ones are not replayed. */
    readonly notifications: Stream.Stream<Notification>;
  }
>()("@j3-bots/client-runtime/stores/Presence") {}

export const layer = Layer.effect(
  Presence,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const view = yield* SubscriptionRef.make<View>({ pairing: null, target: null });
    const notifications = yield* PubSub.unbounded<Notification>();

    yield* connection
      .eachSession((client, pairing) =>
        SubscriptionRef.changes(view).pipe(
          Stream.map((current) => (current.pairing === pairing ? current.target : null)),
          Stream.changesWith((a, b) => viewKey(a) === viewKey(b)),
          Stream.runForEach((target) => client["client.view"]({ target })),
        ),
      )
      .pipe(Effect.forkScoped);

    yield* connection
      .eachSession((client, pairing) =>
        client["notifications.subscribe"]().pipe(
          Stream.filter(() => connection.pairing.get() === pairing),
          Stream.runForEach((notification) => PubSub.publish(notifications, notification)),
        ),
      )
      .pipe(Effect.forkScoped);

    return Presence.of({
      setView: Effect.fn("Presence.setView")(function* (target: EntryTarget | null) {
        yield* SubscriptionRef.set(view, { pairing: connection.pairing.get(), target });
      }),
      notifications: Stream.fromPubSub(notifications),
    });
  }),
);
