// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  DeviceId,
  EntryId,
  EntryKind,
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
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Time, timeText } from "../persistence/columns.ts";
import { notificationKindOf } from "../presence/Presence.ts";
import { transactional } from "../persistence/transaction.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { onePassAtATime, passOutcome, reconcileWithoutEngine } from "../turns/reconciler.ts";
import { Signals } from "../turns/Signals.ts";
import { failureTag } from "./failureTag.ts";
import {
  MAX_MESSAGES_PER_SEND,
  PushDeliveryId,
  type PushMessage,
  PushReceiptId,
  type PushRejected,
  PushSender,
  type PushThrottled,
  type PushUnregistered,
} from "./PushSender.ts";

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

/**
 * The most deliveries one pass reads, of receipts due and of sends due: the
 * sends go in one request. A pass that finds this many leaves the rest to the
 * next, a few seconds later, which first reads the receipts and ends the
 * deliveries that came due meanwhile.
 */
const BATCH = MAX_MESSAGES_PER_SEND;

const PushService = Schema.Struct({ not_before: Schema.NullOr(Time) });

/** A pending delivery due now, with what sending it needs. */
const Due = Schema.Struct({
  id: PushDeliveryId,
  entry_id: EntryId,
  device_id: DeviceId,
  title: Schema.String,
  body: Schema.String,
  plain_body: Schema.String,
  /** The kind of the entry the push is about, whose notification names the channel. */
  kind: EntryKind,
  attempts: Schema.Int,
  generation: Schema.NullOr(Schema.String),
  conversation_bot_id: Schema.NullOr(BotId),
  room_id: Schema.NullOr(RoomId),
  provider: Schema.NullOr(PushProvider),
  token: Schema.NullOr(PushToken),
  platform: Schema.NullOr(PushPlatform),
  registered_generation: Schema.NullOr(Schema.String),
});
type Due = typeof Due.Type;
const decodeDue = Schema.decodeUnknownEffect(Due);

/** A delivery the service took whose receipt is due now. */
const Taken = Schema.Struct({
  id: PushDeliveryId,
  device_id: DeviceId,
  generation: Schema.String,
  receipt_id: PushReceiptId,
});
type Taken = typeof Taken.Type;
const decodeTaken = Schema.decodeUnknownEffect(Taken);

/** A delivery past its deadline. */
const Expired = Schema.Struct({
  id: PushDeliveryId,
  device_id: DeviceId,
  status: Schema.Literals(["pending", "accepted"]),
  attempts: Schema.Int,
  generation: Schema.NullOr(Schema.String),
});
const decodeExpired = Schema.decodeUnknownEffect(Expired);

/**
 * One send as it was begun: to which device, and which of its registrations.
 * What its answer says about the device holds only for that registration, so
 * one made since, even in the same millisecond, is left alone.
 */
interface Attempt {
  readonly deviceId: DeviceId;
  readonly generation: string;
}

/** The last send begun for a delivery, if one was. */
const lastAttempt = (delivery: {
  readonly device_id: DeviceId;
  readonly generation: string | null;
}): Attempt | null =>
  delivery.generation === null
    ? null
    : { deviceId: delivery.device_id, generation: delivery.generation };

/** A row's id, to name it in the logs even when the rest of it cannot be read. */
const rowId = (row: Readonly<Record<string, unknown>>): string =>
  typeof row["id"] === "string" ? row["id"] : "";

/**
 * Sends the pushes `PushDeliveries` wrote (`docs/architecture/server.md`,
 * Notifications): a reconciler (decision 0010) whose every deadline is a
 * column, so a restart resumes where the last process stopped.
 *
 * A send is claimed before it is made: recorded as begun, with the time the
 * next one may begin, only while its deadline has not passed and the device's
 * registration is the one the pass read. The claim reads the operator's
 * settings in its own transaction and words the send by them: none while
 * notifications are off, and no preview while previews are. Once the claim
 * commits, the send is under way. So a crash between a send and its record
 * leaves the delivery due again at that time, never at once and never past its
 * bounds: it is sent again with the same key, its id, which the push service
 * uses to replace a notification still shown with the second
 * (`ExpoPushSender`). A delivery ends when the service took it and later
 * reported it handed on, or when it cannot be: the device is no longer
 * registered, the service refused it, its sends ran out, or its deadline
 * passed. Each end deletes it; a device the service no longer reaches loses
 * its registration.
 *
 * Receipts are read before any send, so a service that does not answer sends
 * holds back no receipt. A pass's sends go in one request, which the sender
 * bounds in time, so slow sends hold back neither receipts nor deadlines for
 * long. A request the service does not answer counts a send for each delivery
 * in it, and sets, durably, when the service may next be tried: no send
 * begins before then, one written since included.
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
    const settings = yield* SettingsStore;
    const signals = yield* Signals;

    const settle = (id: string) =>
      sql`DELETE FROM push_deliveries WHERE id = ${id}`.pipe(Effect.asVoid, Effect.orDie);

    /** One more send to the device ended without reaching it, if it went to its registration. */
    const failed = (attempt: Attempt | null) =>
      attempt === null
        ? Effect.void
        : sql`
            UPDATE push_registrations SET failures = failures + 1
            WHERE device_id = ${attempt.deviceId} AND generation = ${attempt.generation}
          `.pipe(Effect.asVoid, Effect.orDie);

    /**
     * The service no longer reaches the app at the registration `attempt`
     * went to: that registration ends, unless the device registered again since.
     */
    const unregistered = (id: PushDeliveryId, attempt: Attempt) =>
      transaction(
        Effect.gen(function* () {
          const ended = yield* sql`
            DELETE FROM push_registrations
            WHERE device_id = ${attempt.deviceId} AND generation = ${attempt.generation}
            RETURNING device_id
          `;
          yield* settle(id);
          return ended.length > 0;
        }),
      ).pipe(
        Effect.andThen((ended) =>
          ended
            ? Effect.logInfo("A device no longer takes pushes; its registration ended").pipe(
                Effect.annotateLogs({ deliveryId: id, deviceId: attempt.deviceId }),
              )
            : Effect.void,
        ),
      );

    /** The delivery ends without reaching the device, for `reason`, one the sender chose. */
    const gaveUp = (id: PushDeliveryId, attempt: Attempt | null, reason: string) =>
      transaction(Effect.andThen(failed(attempt), settle(id))).pipe(
        Effect.andThen(
          Effect.logWarning("A push was not delivered").pipe(
            Effect.annotateLogs({ deliveryId: id, deviceId: attempt?.deviceId ?? null, reason }),
          ),
        ),
      );

    const later = (id: PushDeliveryId, at: DateTime.Utc) =>
      sql`UPDATE push_deliveries SET due_at = ${timeText(at)} WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );

    /** One delivery past its deadline: a send never taken, or a receipt never read. */
    const expireOne = Effect.fn("PushWorker.expireOne")(function* (
      row: Readonly<Record<string, unknown>>,
    ) {
      const delivery = yield* decodeExpired(row).pipe(Effect.orDie);
      // Only sends that failed count: a receipt never read says nothing
      // either way, and a delivery never sent failed no send.
      const attempt = delivery.status === "pending" ? lastAttempt(delivery) : null;
      yield* transaction(Effect.andThen(failed(attempt), settle(delivery.id)));
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
    });

    /**
     * Ends what is past its deadline, each delivery alone: one that cannot be
     * handled is logged and deleted all the same, since its deadline ended it.
     */
    const expire = Effect.fn("PushWorker.expire")(function* () {
      const rows = yield* sql`
        SELECT id, device_id, status, attempts, generation FROM push_deliveries
        WHERE deadline_at <= ${timeText(yield* DateTime.now)}
      `.pipe(Effect.orDie);
      for (const row of rows) {
        const id = rowId(row);
        yield* expireOne(row).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logError("A push past its deadline could not be handled; it is dropped").pipe(
                Effect.annotateLogs({ deliveryId: id, failure: failureTag(cause) }),
                Effect.andThen(settle(id)),
              ),
          ),
        );
      }
    });

    /**
     * Claims the next send of `delivery` to the registration `generation`,
     * and words it by the settings as the claim leaves them, read in its
     * transaction: a change to them commits before the claim, and is followed,
     * or after it, once the send is under way. `null` when nothing is to be
     * sent: the delivery changed since the pass read it, or notifications are
     * off, which ends it without a failed send.
     */
    const claim = (delivery: Due, generation: string) =>
      transaction(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const count = delivery.attempts + 1;
          const begun = yield* sql`
            UPDATE push_deliveries
            SET attempts = ${count}, generation = ${generation},
              due_at = ${timeText(DateTime.addDuration(now, sendBackoff(count)))}
            WHERE id = ${delivery.id} AND status = 'pending' AND attempts = ${delivery.attempts}
              AND deadline_at > ${timeText(now)}
              AND EXISTS (
                SELECT 1 FROM push_registrations r
                WHERE r.device_id = ${delivery.device_id} AND r.generation = ${generation}
              )
            RETURNING id
          `.pipe(Effect.orDie);
          if (begun.length === 0) return null;
          const { notifications } = yield* settings.get;
          if (!notifications.enabled) {
            yield* settle(delivery.id);
            return null;
          }
          return {
            count,
            // Never a preview the operator turned off since it was written.
            body: notifications.previews ? delivery.body : delivery.plain_body,
          };
        }),
      );

    /** What the service answered about a send it was asked: all but not answering. */
    type Answered = Result.Result<
      PushReceiptId | null,
      PushThrottled | PushUnregistered | PushRejected
    >;

    /** A send claimed: the delivery, its message, and the registration it goes to. */
    interface Claimed {
      readonly delivery: Due;
      /** Which send of the delivery this is. */
      readonly count: number;
      readonly attempt: Attempt;
      readonly message: PushMessage;
    }

    /**
     * Readies one pending delivery's next send: claimed, with its message.
     * `null` when there is none to make, the delivery ended where it cannot be
     * sent.
     */
    const prepare = Effect.fn("PushWorker.prepare")(function* (delivery: Due) {
      const {
        provider,
        token,
        platform,
        registered_generation: generation,
        conversation_bot_id: botId,
        room_id: roomId,
      } = delivery;
      if (provider === null || token === null || platform === null || generation === null) {
        // Unregistered or revoked since it was written: nothing to send to.
        yield* settle(delivery.id);
        return null;
      }
      if (delivery.attempts >= MAX_ATTEMPTS) {
        yield* gaveUp(delivery.id, lastAttempt(delivery), `no send succeeded in ${MAX_ATTEMPTS}`);
        return null;
      }
      const target: EntryTarget | null =
        botId !== null
          ? { _tag: "conversation", botId }
          : roomId !== null
            ? { _tag: "room", roomId }
            : null;
      if (target === null) return yield* Effect.die("An entry has a target");
      const kind = notificationKindOf(delivery.kind);
      if (kind === null) return yield* Effect.die("A delivery is about an entry that notifies");
      const claimed = yield* claim(delivery, generation);
      if (claimed === null) return null;
      return {
        delivery,
        count: claimed.count,
        attempt: { deviceId: delivery.device_id, generation },
        message: {
          key: delivery.id,
          provider,
          token,
          platform,
          title: delivery.title,
          body: claimed.body,
          kind,
          data: { deviceId: delivery.device_id, target, entryId: delivery.entry_id },
        },
      } satisfies Claimed;
    });

    /** What the service answered about one claimed send, recorded. */
    const record = Effect.fn("PushWorker.record")(function* (claimed: Claimed, sent: Answered) {
      const { delivery, attempt } = claimed;
      if (sent._tag === "Success") {
        if (sent.success === null) return yield* settle(delivery.id);
        // Taken: its words are no longer needed, its receipt is.
        const accepted = yield* DateTime.now;
        yield* sql`
          UPDATE push_deliveries
          SET status = 'accepted', title = NULL, body = NULL, plain_body = NULL,
            receipt_id = ${sent.success},
            due_at = ${timeText(DateTime.addDuration(accepted, RECEIPT_DELAY))},
            deadline_at = ${timeText(DateTime.addDuration(accepted, RECEIPT_WINDOW))}
          WHERE id = ${delivery.id}
        `.pipe(Effect.orDie);
        return;
      }
      const error = sent.failure;
      switch (error._tag) {
        case "PushUnregistered":
          return yield* unregistered(delivery.id, attempt);
        case "PushRejected":
          return yield* gaveUp(delivery.id, attempt, error.reason);
        case "PushThrottled":
          // Due again when the next send may begin, as recorded before this one.
          return yield* Effect.logInfo("A push could not be sent; it is tried again").pipe(
            Effect.annotateLogs({
              deliveryId: delivery.id,
              attempt: claimed.count,
              reason: "MessageRateExceeded",
            }),
          );
      }
    });

    /** What the service later said about deliveries it took. */
    const readReceipts = Effect.fn("PushWorker.readReceipts")(function* (
      taken: ReadonlyArray<Taken>,
    ) {
      if (taken.length === 0) return;
      const answers = yield* sender.receipts(taken.map((delivery) => delivery.receipt_id));
      const again = DateTime.addDuration(yield* DateTime.now, RECEIPT_RETRY);
      for (const delivery of taken) {
        const { id } = delivery;
        const attempt: Attempt = { deviceId: delivery.device_id, generation: delivery.generation };
        const answer = answers.get(delivery.receipt_id);
        if (answer === undefined) {
          yield* later(id, again);
          continue;
        }
        switch (answer._tag) {
          case "delivered":
            yield* settle(id);
            break;
          case "unregistered":
            yield* unregistered(id, attempt);
            break;
          case "throttled":
            // Its words are gone, so it is not sent again; the device is
            // reachable, so its registration counts no failure.
            yield* settle(id);
            yield* Effect.logWarning("A push was not delivered").pipe(
              Effect.annotateLogs({
                deliveryId: id,
                deviceId: attempt.deviceId,
                reason: "MessageRateExceeded",
              }),
            );
            break;
          case "rejected":
            yield* gaveUp(id, attempt, answer.reason);
            break;
        }
      }
    });

    /**
     * Each delivery alone: a defect is logged, by the delivery and the
     * failure's tag, and that delivery waits, while the pass goes on with the
     * others. A send begun counts against its bounds before it is made, so a
     * defect that repeats ends it in time.
     */
    const supervised = (id: string, step: Effect.Effect<void>) =>
      step.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("A push could not be handled; it is tried again later").pipe(
                Effect.annotateLogs({ deliveryId: id, failure: failureTag(cause) }),
              );
              const now = yield* DateTime.now;
              yield* sql`
                UPDATE push_deliveries SET due_at = ${timeText(DateTime.addDuration(now, DEFECT_DELAY))}
                WHERE id = ${id}
              `.pipe(Effect.orDie);
            }),
        ),
      );

    /** The receipts due now. Whether there may be more than one pass reads. */
    const followReceipts = Effect.fn("PushWorker.followReceipts")(function* () {
      const rows = yield* sql`
        SELECT id, device_id, generation, receipt_id FROM push_deliveries
        WHERE status = 'accepted' AND due_at <= ${timeText(yield* DateTime.now)}
        ORDER BY due_at, id
        LIMIT ${BATCH}
      `.pipe(Effect.orDie);
      // Decoded one by one, so a row that cannot be read waits alone.
      const taken: Array<Taken> = [];
      for (const row of rows) {
        yield* supervised(
          rowId(row),
          Effect.map(decodeTaken(row).pipe(Effect.orDie), (delivery) => {
            taken.push(delivery);
          }),
        );
      }
      // A defect reading receipts holds those receipts back, not the pass.
      yield* readReceipts(taken).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("Push receipts could not be handled").pipe(
                Effect.annotateLogs({ failure: failureTag(cause) }),
              );
              const at = DateTime.addDuration(yield* DateTime.now, DEFECT_DELAY);
              for (const delivery of taken) yield* later(delivery.id, at);
            }),
        ),
      );
      return rows.length === BATCH;
    });

    /** When the service may next be tried, if it did not answer the last time. */
    const notBefore = SqlSchema.findAll({
      Request: Schema.Void,
      Result: PushService,
      execute: () => sql`SELECT not_before FROM push_service`,
    })(undefined).pipe(
      Effect.map(([service]) => service?.not_before ?? null),
      Effect.orDie,
    );

    /**
     * The sends due now, unless the service is not to be tried yet, claimed
     * and sent in one request. Whether there may be more than one pass reads.
     */
    const sendDue = Effect.fn("PushWorker.sendDue")(function* () {
      const started = yield* DateTime.now;
      const until = yield* notBefore;
      if (until !== null && DateTime.isGreaterThan(until, started)) return false;
      const rows = yield* sql`
        SELECT d.id, d.entry_id, d.device_id, d.title, d.body, d.plain_body, e.kind, d.attempts,
          d.generation, e.conversation_bot_id, e.room_id, r.provider, r.token, r.platform,
          r.generation AS registered_generation
        FROM push_deliveries d
        JOIN entries e ON e.id = d.entry_id
        LEFT JOIN push_registrations r ON r.device_id = d.device_id
        WHERE d.status = 'pending' AND d.due_at <= ${timeText(started)}
        ORDER BY d.due_at, d.id
        LIMIT ${BATCH}
      `.pipe(Effect.orDie);
      const more = rows.length === BATCH;
      const claimed: Array<Claimed> = [];
      for (const row of rows) {
        // Decoded and claimed one by one, so a row that cannot be read waits alone.
        yield* supervised(
          rowId(row),
          Effect.gen(function* () {
            const ready = yield* prepare(yield* decodeDue(row).pipe(Effect.orDie));
            if (ready !== null) claimed.push(ready);
          }),
        );
      }
      if (claimed.length === 0) return more;
      const sent = yield* sender.send(claimed.map(({ message }) => message)).pipe(
        // Each send is claimed, so each comes due again when its next may begin.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logError("Pushes could not be handled; they are tried again later").pipe(
              Effect.annotateLogs({ pushes: claimed.length, failure: failureTag(cause) }),
              Effect.as(null),
            ),
        ),
      );
      if (sent === null) return more;
      const unanswered: Array<Claimed> = [];
      let reason = "";
      for (const [index, one] of claimed.entries()) {
        const answer = sent[index];
        if (answer === undefined) return yield* Effect.die("The push sender answers each message");
        if (Result.isSuccess(answer)) {
          yield* supervised(one.delivery.id, record(one, Result.succeed(answer.success)));
          continue;
        }
        const { failure } = answer;
        if (failure._tag === "PushUnavailable") {
          unanswered.push(one);
          reason = failure.reason;
          continue;
        }
        yield* supervised(one.delivery.id, record(one, Result.fail(failure)));
      }
      // A service that does not answer says nothing of any one push: only the
      // furthest along of those it did not answer counts a send, and sets how
      // long the service is left alone; the others give theirs back and wait
      // for it, so an outage spends one push's sends at a time, as when they
      // went alone.
      const [lead, ...waiting] = unanswered.toSorted((a, b) => b.count - a.count);
      if (lead === undefined) return more;
      yield* Effect.logInfo("The push service did not take pushes; sends wait").pipe(
        Effect.annotateLogs({ pushes: unanswered.length, attempt: lead.count, reason }),
      );
      const resumes = timeText(DateTime.addDuration(yield* DateTime.now, sendBackoff(lead.count)));
      // No send begins before then, one written since included.
      yield* sql`UPDATE push_service SET not_before = ${resumes}`.pipe(Effect.orDie);
      for (const { delivery, count } of waiting) {
        yield* supervised(
          delivery.id,
          sql`
            UPDATE push_deliveries
            SET attempts = ${delivery.attempts}, generation = ${delivery.generation},
              due_at = ${resumes}
            WHERE id = ${delivery.id} AND status = 'pending' AND attempts = ${count}
          `.pipe(Effect.orDie, Effect.asVoid),
        );
      }
      return false;
    });

    const pass = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        yield* expire();
        if (yield* followReceipts()) outcome.defer();
        if (yield* sendDue()) outcome.defer();
        const [next] = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: Schema.Struct({ due: Schema.NullOr(Time), deadline: Schema.NullOr(Time) }),
          // A send is due no sooner than the service may be tried again.
          execute: () => sql`
            SELECT
              MIN(CASE WHEN d.status = 'pending' AND d.due_at < s.not_before
                THEN s.not_before ELSE d.due_at END) AS due,
              MIN(d.deadline_at) AS deadline
            FROM push_deliveries d LEFT JOIN push_service s ON s.id = 1
          `,
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
