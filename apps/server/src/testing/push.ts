// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type PushDeliveryId,
  type PushMessage,
  type PushReceipt,
  PushReceiptId,
  type PushRejected,
  PushSender,
  type PushUnavailable,
  type PushUnregistered,
} from "../push/PushSender.ts";

/**
 * How the service answers one send: it takes the message, it takes it and the
 * answer never comes (the server stops waiting only when it stops), or it
 * fails as given, without taking it.
 */
export type TestPushAnswer =
  | "take"
  | "take-and-hang"
  | PushUnavailable
  | PushUnregistered
  | PushRejected;

/**
 * An in-memory push service, which outlives a server restart. It shows a
 * device one notification per key, as Expo does by a message's tag or
 * collapse id, and reports every message it took as handed on.
 */
export class TestPushService extends Context.Service<
  TestPushService,
  {
    /** Every send that reached the service, taken or not, in order. */
    readonly sends: Effect.Effect<ReadonlyArray<PushMessage>>;
    /** What devices show: the latest message the service took for each key. */
    readonly shown: Effect.Effect<ReadonlyArray<PushMessage>>;
    /** The next sends get these answers, in order; every later one is taken. */
    readonly answer: (answers: ReadonlyArray<TestPushAnswer>) => Effect.Effect<void>;
  }
>()("@j3-bots/server/testing/push/TestPushService") {}

export const layer = Layer.effectContext(
  Effect.sync(() => {
    const sends: Array<PushMessage> = [];
    const shown = new Map<PushDeliveryId, PushMessage>();
    const answers: Array<TestPushAnswer> = [];

    const send = (message: PushMessage) =>
      Effect.gen(function* () {
        sends.push(message);
        const answer = answers.shift() ?? "take";
        if (typeof answer !== "string") return yield* answer;
        shown.set(message.key, message);
        if (answer === "take-and-hang") return yield* Effect.never;
        return PushReceiptId.make(`receipt-${sends.length}`);
      });

    const receipts = (ids: ReadonlyArray<PushReceiptId>) =>
      Effect.succeed(
        new Map<PushReceiptId, PushReceipt>(ids.map((id) => [id, { _tag: "delivered" }])),
      );

    return Context.make(PushSender, PushSender.of({ send, receipts })).pipe(
      Context.add(
        TestPushService,
        TestPushService.of({
          sends: Effect.sync(() => [...sends]),
          shown: Effect.sync(() => [...shown.values()]),
          answer: (next) =>
            Effect.sync(() => {
              answers.push(...next);
            }),
        }),
      ),
    );
  }),
);
