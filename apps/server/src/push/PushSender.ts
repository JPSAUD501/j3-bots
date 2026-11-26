// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  NotificationKind,
  PushData,
  PushPlatform,
  PushProvider,
  PushToken,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** One push delivery's id: the key that makes every send of it the same notification. */
export const PushDeliveryId = Schema.String.pipe(Schema.brand("PushDeliveryId"));
export type PushDeliveryId = typeof PushDeliveryId.Type;

/** What a push service gave back for a message it took, to ask later how it went. */
export const PushReceiptId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("PushReceiptId"),
);
export type PushReceiptId = typeof PushReceiptId.Type;

/** One notification to one device. */
export interface PushMessage {
  /**
   * The delivery's id. Every send of one delivery carries it, so a push
   * service that can collapse or deduplicate by key shows it once.
   */
  readonly key: PushDeliveryId;
  readonly provider: PushProvider;
  readonly token: PushToken;
  readonly platform: PushPlatform;
  readonly title: string;
  readonly body: string;
  /** What the entry is, which names the Android channel it shows in (`NotificationKind`). */
  readonly kind: NotificationKind;
  /** What the app opens when the notification is tapped. */
  readonly data: PushData;
}

/**
 * The service could not be reached, did not answer in time, or asked to come
 * back later: no message would pass now, these included, though the same
 * send may later. `reason` is one the sender chose, never text the service
 * sent.
 */
export class PushUnavailable extends Schema.TaggedError<PushUnavailable>()("PushUnavailable", {
  reason: Schema.String,
}) {}

/**
 * The service refused this message because too many went to its device just
 * now: the same send may pass later, and messages to other devices pass now.
 */
export class PushThrottled extends Schema.TaggedError<PushThrottled>()("PushThrottled", {}) {}

/** The token no longer reaches the app: the device must register again. */
export class PushUnregistered extends Schema.TaggedError<PushUnregistered>()(
  "PushUnregistered",
  {},
) {}

/**
 * The service refused the message for good, or a request of them as a whole:
 * sending it again would fail the same way. `reason` is one the sender chose,
 * never text the service sent.
 */
export class PushRejected extends Schema.TaggedError<PushRejected>()("PushRejected", {
  reason: Schema.String,
}) {}

/**
 * What came of one message of a send: the service took it, with a receipt to
 * ask about later if the service gives one, refused it, or did not answer
 * about it (`PushUnavailable`).
 */
export type PushSent = Result.Result<
  PushReceiptId | null,
  PushUnavailable | PushThrottled | PushUnregistered | PushRejected
>;

/** The most messages `PushSender.send` takes at once: what Expo takes in one request. */
export const MAX_MESSAGES_PER_SEND = 100;

/** What the service later says about a message it took. */
export type PushReceipt =
  /** Handed to Apple's or Google's service. */
  | { readonly _tag: "delivered" }
  | { readonly _tag: "unregistered" }
  /**
   * Not handed on because too many went to the device at once. Its words are
   * gone, so it is not sent again; nor does it say the device is unreachable.
   */
  | { readonly _tag: "throttled" }
  | { readonly _tag: "rejected"; readonly reason: string };

/**
 * Sends notifications to devices through a push service
 * (`docs/decisions/0014-push-goes-through-a-push-sender.md`). The delivery
 * worker owns retries, deadlines and what follows from each answer; a sender
 * only translates messages, or a question about earlier messages, to its
 * service and back.
 */
export class PushSender extends Context.Service<
  PushSender,
  {
    /**
     * Sends up to `MAX_MESSAGES_PER_SEND` messages: what came of each, in
     * their order. A request the service did not answer, or refused as a
     * whole, is that answer for each message in it.
     */
    readonly send: (messages: ReadonlyArray<PushMessage>) => Effect.Effect<ReadonlyArray<PushSent>>;
    /**
     * What became of messages the service took. A receipt the service has no
     * answer for yet, or that could not be asked for now, is left out: the
     * answers it did give stand on their own.
     */
    readonly receipts: (
      ids: ReadonlyArray<PushReceiptId>,
    ) => Effect.Effect<ReadonlyMap<PushReceiptId, PushReceipt>>;
  }
>()("@j3-bots/server/push/PushSender") {}
