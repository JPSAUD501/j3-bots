// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type PushMessage,
  type PushReceipt,
  PushReceiptId,
  type PushRejected,
  PushSender,
  type PushThrottled,
  type PushUnavailable,
  type PushUnregistered,
} from "../push/PushSender.ts";

/** How the service fails one send, without taking the message. */
type TestPushFailure = PushUnavailable | PushThrottled | PushUnregistered | PushRejected;

/**
 * How the service answers one send: it takes the message, it takes it and the
 * answer never comes (the server stops waiting only when it stops), it
 * answers as `answer` says once `before` ran (for what happens while a send is
 * on its way), or it fails as given.
 */
export type TestPushAnswer =
  | "take"
  | "take-and-hang"
  | {
      readonly _tag: "after";
      readonly before: (message: PushMessage) => Effect.Effect<void>;
      readonly answer: "take" | TestPushFailure;
    }
  | TestPushFailure;

/**
 * An in-memory push service, which outlives a server restart. It reports
 * every message it took as handed on.
 */
export class TestPushService extends Context.Service<
  TestPushService,
  {
    /** Every send that reached the service, taken or not, in order. */
    readonly sends: Effect.Effect<ReadonlyArray<PushMessage>>;
    /** For each time receipts were asked for, how many sends had reached the service then. */
    readonly receiptsAsked: Effect.Effect<ReadonlyArray<number>>;
    /** The next sends get these answers, in order; every later one is taken. */
    readonly answer: (answers: ReadonlyArray<TestPushAnswer>) => Effect.Effect<void>;
  }
>()("@j3-bots/server/testing/push/TestPushService") {}

export const layer = Layer.effectContext(
  Effect.sync(() => {
    const sends: Array<PushMessage> = [];
    const answers: Array<TestPushAnswer> = [];
    const receiptsAsked: Array<number> = [];

    const send = (message: PushMessage) =>
      Effect.gen(function* () {
        sends.push(message);
        let answer = answers.shift() ?? "take";
        if (answer === "take-and-hang") return yield* Effect.never;
        if (answer !== "take" && answer._tag === "after") {
          yield* answer.before(message);
          answer = answer.answer;
        }
        if (answer !== "take") return yield* answer;
        return PushReceiptId.make(`receipt-${sends.length}`);
      });

    const receipts = (ids: ReadonlyArray<PushReceiptId>) =>
      Effect.sync(() => {
        receiptsAsked.push(sends.length);
        return new Map<PushReceiptId, PushReceipt>(ids.map((id) => [id, { _tag: "delivered" }]));
      });

    return Context.make(PushSender, PushSender.of({ send, receipts })).pipe(
      Context.add(
        TestPushService,
        TestPushService.of({
          sends: Effect.sync(() => [...sends]),
          receiptsAsked: Effect.sync(() => [...receiptsAsked]),
          answer: (next) =>
            Effect.sync(() => {
              answers.push(...next);
            }),
        }),
      ),
    );
  }),
);
