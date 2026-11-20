// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryTarget, Notification } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Connection } from "../connection/Connection.ts";
import { targetKey } from "./Conversations.ts";

/**
 * What the operator is looking at, and what the server wants them to know
 * about the rest. The server notifies only about targets no connected client
 * has in view, so the view is sent again on every socket.
 */
export class Presence extends Context.Service<
  Presence,
  {
    /** The conversation or room on screen, or `null` when none is (the app is in the background). */
    readonly setView: (target: EntryTarget | null) => Effect.Effect<void>;
    /** Notifications for this client to show, while connected. Missed ones are not replayed. */
    readonly notifications: Stream.Stream<Notification>;
  }
>()("@j3-bots/client-runtime/stores/Presence") {}

export const layer = Layer.effect(
  Presence,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const view = yield* SubscriptionRef.make<EntryTarget | null>(null);
    const notifications = yield* PubSub.unbounded<Notification>();

    yield* connection
      .eachSession((client) =>
        SubscriptionRef.changes(view).pipe(
          Stream.changesWith(
            (a, b) => (a === null ? null : targetKey(a)) === (b === null ? null : targetKey(b)),
          ),
          Stream.runForEach((target) => client["client.view"]({ target })),
        ),
      )
      .pipe(Effect.forkScoped);

    yield* connection
      .eachSession((client) =>
        client["notifications.subscribe"]().pipe(
          Stream.runForEach((notification) => PubSub.publish(notifications, notification)),
        ),
      )
      .pipe(Effect.forkScoped);

    return Presence.of({
      setView: Effect.fn("Presence.setView")(function* (target: EntryTarget | null) {
        yield* SubscriptionRef.set(view, target);
      }),
      notifications: Stream.fromPubSub(notifications),
    });
  }),
);
