// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  DeviceId,
  EntryId,
  type EntryTarget,
  PushPlatform,
  PushProvider,
  PushToken,
  RoomId,
} from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { onePassAtATime, passOutcome, reconcileWithoutEngine } from "../turns/reconciler.ts";
import { Signals } from "../turns/Signals.ts";
import { PushDeliveryId, type PushReceipt, PushReceiptId, PushSender } from "./PushSender.ts";

/** How many sends of one delivery may begin before it is given up. */
export const MAX_ATTEMPTS = 8;

/** How long after the `n`th send began the next may: doubling from 5 s to 5 min. */
export const sendBackoff = (n: number): Duration.Duration =>
  Duration.min(Duration.seconds(5 * 2 ** Math.max(0, n - 1)), Duration.minutes(5));

/** Expo's advice: look for a receipt about fifteen minutes after the send. */
export const RECEIPT_DELAY = Duration.minutes(15);

/** How long until a receipt that was not there yet, or could not be asked for, is looked for again. */
const RECEIPT_RETRY = Duration.minutes(30);

/** How long a receipt is looked for: Expo clears them after a day. */
const RECEIPT_WINDOW = Duration.hours(24);

/** How long a delivery whose handling failed unexpectedly waits. */
const DEFECT_DELAY = Duration.seconds(30);

/** A delivery due now, with what sending it needs. */
const Due = Schema.Struct({
  id: PushDeliveryId,
  entry_id: EntryId,
  device_id: DeviceId,
  status: Schema.Literals(["pending", "accepted"]),
  title: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
  attempts: Schema.Int,
  token: Schema.NullOr(PushToken),
  receipt_id: Schema.NullOr(PushReceiptId),
  conversation_bot_id: Schema.NullOr(BotId),
  room_id: Schema.NullOr(RoomId),
  provider: Schema.NullOr(PushProvider),
  registered_token: Schema.NullOr(PushToken),
  platform: Schema.NullOr(PushPlatform),
});
type Due = typeof Due.Type;
const decodeDue = Schema.decodeUnknownEffect(Due);

/** A delivery past its deadline. */
const Expired = Schema.Struct({
  id: PushDeliveryId,
  device_id: DeviceId,
  status: Schema.Literals(["pending", "accepted"]),
  attempts: Schema.Int,
});

/**
 * Sends the pushes `PushDeliveries` wrote (`docs/architecture/server.md`,
 * Notifications): a reconciler (decision 0010) whose every deadline is a
 * column, so a restart resumes where the last process stopped.
 *
 * A send is recorded as begun, with the time the next one may begin, before
 * it is made. So a crash between a send and its record leaves the delivery
 * due again at that time, never at once and never past its bounds: it is sent
 * again with the same key, its id, which the push service uses to show the
 * second as the first (`ExpoPushSender`). A delivery ends when the service
 * took it and later reported it handed on, or when it cannot be: the device
 * is no longer registered, the service refused it, its sends ran out, or its
 * deadline passed. Each end deletes it; a device the service no longer
 * reaches loses its registration.
 */
export class PushWorker extends Context.Service<
  PushWorker,
  {
    /** One pass over the deliveries that are due. */
    readonly deliverPending: Effect.Effect<void>;
  }
>()("@j3-bots/server/push/PushWorker") {}

export const layer = Layer.effect(
  PushWorker,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = transactional(sql);
    const sender = yield* PushSender;
    const signals = yield* Signals;

    const settle = (id: PushDeliveryId) =>
      sql`DELETE FROM push_deliveries WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie);

    /** One more send to the device ended without reaching it. */
    const failed = (deviceId: DeviceId) =>
      sql`
        UPDATE push_registrations SET failures = failures + 1 WHERE device_id = ${deviceId}
      `.pipe(Effect.asVoid, Effect.orDie);

    /**
     * The service no longer reaches the app at `token`: the device's
     * registration ends, unless it registered another token since.
     */
    const unregistered = (delivery: Due, token: PushToken) =>
      transaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM push_registrations
            WHERE device_id = ${delivery.device_id} AND token = ${token}
          `;
          yield* settle(delivery.id);
        }),
      ).pipe(
        Effect.andThen(
          Effect.logInfo("A device no longer takes pushes; its registration ended").pipe(
            Effect.annotateLogs({ deviceId: delivery.device_id }),
          ),
        ),
      );

    /** The delivery ends without reaching the device, for `reason`. */
    const gaveUp = (delivery: Due, reason: string) =>
      transaction(Effect.andThen(failed(delivery.device_id), settle(delivery.id))).pipe(
        Effect.andThen(
          Effect.logWarning("A push was not delivered").pipe(
            Effect.annotateLogs({ deliveryId: delivery.id, deviceId: delivery.device_id, reason }),
          ),
        ),
      );

    const later = (id: PushDeliveryId, at: DateTime.Utc) =>
      sql`UPDATE push_deliveries SET due_at = ${timeText(at)} WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    /** Ends what is past its deadline: a send never taken, or a receipt never read. */
    const expire = Effect.fn("PushWorker.expire")(function* (now: DateTime.Utc) {
      const expired = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: Expired,
        execute: () => sql`
          SELECT id, device_id, status, attempts FROM push_deliveries
          WHERE deadline_at <= ${timeText(now)}
        `,
      })(undefined).pipe(Effect.orDie);
      for (const delivery of expired) {
        yield* transaction(
          Effect.gen(function* () {
            // Only sends that failed count: a receipt never read says nothing
            // either way, and a delivery never sent failed no send.
            if (delivery.status === "pending" && delivery.attempts > 0) {
              yield* failed(delivery.device_id);
            }
            yield* settle(delivery.id);
          }),
        );
        yield* Effect.logWarning(
          delivery.status === "pending"
            ? "A push was not delivered"
            : "No receipt came for a push; it is no longer followed",
        ).pipe(
          Effect.annotateLogs({
            deliveryId: delivery.id,
            deviceId: delivery.device_id,
            ...(delivery.status === "pending"
              ? { reason: "deadline", attempts: delivery.attempts }
              : {}),
          }),
        );
      }
    });

    /** One pending delivery: begun on the record, sent, and what came of it recorded. */
    const sendOne = Effect.fn("PushWorker.sendOne")(function* (delivery: Due, now: DateTime.Utc) {
      const {
        provider,
        registered_token: token,
        platform,
        title,
        body,
        conversation_bot_id: botId,
        room_id: roomId,
      } = delivery;
      if (provider === null || token === null || platform === null) {
        // Unregistered or revoked since it was written: nothing to send to.
        return yield* settle(delivery.id);
      }
      if (delivery.attempts >= MAX_ATTEMPTS) {
        return yield* gaveUp(delivery, `no send succeeded in ${MAX_ATTEMPTS}`);
      }
      if (title === null || body === null) return yield* Effect.die("A pending push has its words");
      const target: EntryTarget | null =
        botId !== null
          ? { _tag: "conversation", botId }
          : roomId !== null
            ? { _tag: "room", roomId }
            : null;
      if (target === null) return yield* Effect.die("An entry has a target");
      const attempt = delivery.attempts + 1;
      const begun = yield* sql`
        UPDATE push_deliveries
        SET attempts = ${attempt}, token = ${token},
          due_at = ${timeText(DateTime.addDuration(now, sendBackoff(attempt)))}
        WHERE id = ${delivery.id} AND status = 'pending' AND attempts = ${delivery.attempts}
        RETURNING id
      `.pipe(Effect.orDie);
      if (begun.length === 0) return;
      const sent = yield* sender
        .send({
          key: delivery.id,
          provider,
          token,
          platform,
          title,
          body,
          data: { deviceId: delivery.device_id, target, entryId: delivery.entry_id },
        })
        .pipe(Effect.result);
      if (sent._tag === "Success") {
        if (sent.success === null) return yield* settle(delivery.id);
        // Taken: its words are no longer needed, its receipt is.
        const accepted = yield* DateTime.now;
        yield* sql`
          UPDATE push_deliveries
          SET status = 'accepted', title = NULL, body = NULL, receipt_id = ${sent.success},
            due_at = ${timeText(DateTime.addDuration(accepted, RECEIPT_DELAY))},
            deadline_at = ${timeText(DateTime.addDuration(accepted, RECEIPT_WINDOW))}
          WHERE id = ${delivery.id}
        `.pipe(Effect.orDie);
        return;
      }
      const error = sent.failure;
      switch (error._tag) {
        case "PushUnregistered":
          return yield* unregistered(delivery, token);
        case "PushRejected":
          return yield* gaveUp(delivery, error.reason);
        case "PushUnavailable":
          // Due again when the next send may begin, as recorded before this one.
          return yield* Effect.logInfo("A push could not be sent; it is tried again").pipe(
            Effect.annotateLogs({ deliveryId: delivery.id, attempt, reason: error.reason }),
          );
      }
    });

    /** What the service later said about deliveries it took. */
    const readReceipts = Effect.fn("PushWorker.readReceipts")(function* (
      accepted: ReadonlyArray<Due>,
      now: DateTime.Utc,
    ) {
      const asked = accepted.flatMap((delivery) =>
        delivery.receipt_id === null || delivery.token === null
          ? []
          : [{ delivery, receipt: delivery.receipt_id, token: delivery.token }],
      );
      if (asked.length === 0) return;
      const again = DateTime.addDuration(now, RECEIPT_RETRY);
      const answers = yield* sender
        .receipts(asked.map(({ receipt }) => receipt))
        .pipe(
          Effect.catchTag("PushUnavailable", (error) =>
            Effect.logInfo("Push receipts could not be read; they are asked for again").pipe(
              Effect.annotateLogs({ reason: error.reason }),
              Effect.as(new Map<PushReceiptId, PushReceipt>()),
            ),
          ),
        );
      for (const { delivery, receipt, token } of asked) {
        const answer = answers.get(receipt);
        if (answer === undefined) {
          yield* later(delivery.id, again);
          continue;
        }
        switch (answer._tag) {
          case "delivered":
            yield* settle(delivery.id);
            break;
          case "unregistered":
            yield* unregistered(delivery, token);
            break;
          case "rejected":
            yield* gaveUp(delivery, answer.reason);
            break;
        }
      }
    });

    /**
     * Each delivery alone: a defect is logged and that delivery waits, while
     * the pass goes on with the others. A send begun counts against its
     * bounds before it is made, so a defect that repeats ends it in time.
     */
    const supervised = (id: string, step: Effect.Effect<void>) =>
      step.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("A push could not be handled; it is tried again later", cause);
              const now = yield* DateTime.now;
              yield* sql`
                UPDATE push_deliveries SET due_at = ${timeText(DateTime.addDuration(now, DEFECT_DELAY))}
                WHERE id = ${id}
              `.pipe(Effect.orDie);
            }),
        ),
      );

    const pass = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        const now = yield* DateTime.now;
        yield* expire(now);
        // Decoded one by one, so a row that cannot be read waits alone.
        const rows = yield* sql`
          SELECT d.id, d.entry_id, d.device_id, d.status, d.title, d.body, d.attempts, d.token,
            d.receipt_id, e.conversation_bot_id, e.room_id, r.provider,
            r.token AS registered_token, r.platform
          FROM push_deliveries d
          JOIN entries e ON e.id = d.entry_id
          LEFT JOIN push_registrations r ON r.device_id = d.device_id
          WHERE d.due_at <= ${timeText(now)}
          ORDER BY d.due_at, d.id
        `.pipe(Effect.orDie);
        const receipts: Array<Due> = [];
        for (const row of rows) {
          const id = typeof row["id"] === "string" ? row["id"] : "";
          yield* supervised(
            id,
            Effect.gen(function* () {
              const delivery = yield* decodeDue(row).pipe(Effect.orDie);
              if (delivery.status === "accepted") receipts.push(delivery);
              else yield* sendOne(delivery, now);
            }),
          );
        }
        // A defect reading receipts holds those receipts back, not the pass.
        yield* readReceipts(receipts, now).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("Push receipts could not be handled", cause);
                const at = DateTime.addDuration(yield* DateTime.now, DEFECT_DELAY);
                for (const delivery of receipts) yield* later(delivery.id, at);
              }),
          ),
        );
        const [next] = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: Schema.Struct({ due: Schema.NullOr(Time), deadline: Schema.NullOr(Time) }),
          execute: () =>
            sql`SELECT MIN(due_at) AS due, MIN(deadline_at) AS deadline FROM push_deliveries`,
        })(undefined).pipe(Effect.orDie);
        outcome.until(next?.due ?? null);
        outcome.until(next?.deadline ?? null);
        return outcome.done();
      }).pipe(Effect.withSpan("PushWorker.deliverPending")),
    );

    yield* Effect.forkScoped(
      reconcileWithoutEngine({ name: "The push worker", pass, signal: signals.push }),
    );

    return PushWorker.of({ deliverPending: Effect.asVoid(pass) });
  }),
);
