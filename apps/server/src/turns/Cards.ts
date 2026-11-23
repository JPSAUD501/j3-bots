// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type CommandId,
  Conflict,
  type Credential,
  type CredentialDraft,
  type CredentialId,
  type ConnectorSuggestionEntry,
  type CredentialRequestEntry,
  type Entry,
  EntryId,
  Invalid,
  NotFound,
  type Question,
  type QuestionAnswers,
  type QuestionEntry,
  RoomId,
} from "@j3-bots/contracts";
import {
  Engine,
  IdempotencyKey,
  RequestId,
  type SecretAnswer,
  SessionId,
} from "@j3-bots/engine-t3";
import type { Wake } from "@j3-bots/prompts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { Entries } from "../entries/Entries.ts";
import { SettingsStore } from "../settings/SettingsStore.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { Ids } from "../Ids.ts";
import { transactional } from "../persistence/transaction.ts";
import { Vault } from "../vault/Vault.ts";
import { askAnswer, fitsAlone, operatorZone, WIDEST_ROOM_NAME } from "./envelopes.ts";
import { keyedLock } from "./keyedLock.ts";
import { Ledger } from "./Ledger.ts";
import { liveTarget } from "./liveTarget.ts";
import {
  AudienceColumn,
  audienceOf,
  recoveryBackoff,
  SessionRowId,
  StoredResponse,
  TurnsInvariant,
} from "./model.ts";
import { Observer } from "./Observer.ts";
import { Readiness } from "./Readiness.ts";
import { type Pass, onePassAtATime, passOutcome, reconcile } from "./reconciler.ts";
import { sessionLoss } from "./sessionRecords.ts";
import { Signals } from "./Signals.ts";
import { Wakes } from "./Wakes.ts";
import { WorkSteps } from "./WorkSteps.ts";

/** What `card.answer` carries. */
export type CardAnswer =
  | { readonly _tag: "question"; readonly answers: QuestionAnswers }
  | { readonly _tag: "dismiss" }
  | {
      readonly _tag: "approval";
      readonly decision: "allow-once" | "allow-session" | "deny";
    };

const AskCardRow = Schema.Struct({
  closed_at: Schema.NullOr(Time),
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  option_values_json: json(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});

const RequestRow = Schema.Struct({
  entry_id: EntryId,
  session_id: SessionRowId,
  engine_session_id: Schema.NullOr(SessionId),
  engine_request_id: RequestId,
  closed_at: Schema.NullOr(Time),
  response_json: Schema.NullOr(json(StoredResponse)),
  submitted: Schema.BooleanFromBit,
});
type RequestRow = typeof RequestRow.Type;

const PendingResponse = Schema.Struct({
  entry_id: EntryId,
  session_id: SessionRowId,
  engine_session_id: SessionId,
  engine_request_id: RequestId,
  response_json: json(StoredResponse),
  response_failures: Schema.Int,
  response_retry_at: Schema.NullOr(Time),
});

const encodeResponse = Schema.encodeEffect(json(StoredResponse));

/** The engine key of the answer to a card: one card takes one answer. */
const answerKey = (entryId: EntryId) => IdempotencyKey.make(`answer:${entryId}`);

/**
 * Whether answers fit the card's questions: known options, one unless several
 * are allowed, text only where accepted. An engine question takes a choice or
 * a typed answer, never both: the engine receives a typed answer alone
 * (`engineAnswersOf`), so a choice beside it would show on the card without
 * reaching the turn. An `ask` question takes both.
 */
const fits = (
  questions: ReadonlyArray<Question>,
  answers: QuestionAnswers,
  origin: QuestionEntry["origin"],
): boolean => {
  const byId = new Map(questions.map((question) => [question.id, question]));
  if (Object.keys(answers).some((id) => !byId.has(id))) return false;
  return questions.every((question) => {
    const answer = answers[question.id];
    if (answer === undefined) return false;
    const options = new Set(question.options.map((option) => option.id));
    const text = answer.text?.trim() ?? "";
    return (
      answer.optionIds.every((id) => options.has(id)) &&
      new Set(answer.optionIds).size === answer.optionIds.length &&
      (question.multiple || answer.optionIds.length <= 1) &&
      (question.acceptsText || answer.text === null) &&
      (origin === "ask" || answer.optionIds.length === 0 || answer.text === null) &&
      (answer.optionIds.length > 0 || text.length > 0)
    );
  });
};

/** What the engine is sent for an answer to its request's card, if the answer fits the card. */
const responseFor = (
  card: Entry,
  answer: CardAnswer,
): StoredResponse | "invalid" | "not-dismissible" | "closed" => {
  switch (card._tag) {
    case "approval":
      if (card.status._tag !== "pending") return "closed";
      if (answer._tag !== "approval") return "invalid";
      if (answer.decision === "allow-session" && card.sessionGrant === null) return "invalid";
      return { _tag: "approval", decision: answer.decision };
    case "question":
      if (card.status._tag !== "pending") return "closed";
      // The engine takes no dismissal of a question that holds a turn: it is
      // answered, or the turn is stopped.
      if (answer._tag === "dismiss") return "not-dismissible";
      return answer._tag === "question" && fits(card.questions, answer.answers, card.origin)
        ? { _tag: "question", answers: answer.answers }
        : "invalid";
    case "secret-request":
      // Answered with `secret.provide`, which keeps no value.
      return card.status === "pending" ? "invalid" : "closed";
    default:
      return "invalid";
  }
};

/**
 * The cards that wait on the operator (`docs/architecture/server.md`,
 * Questions, approvals and secrets). An `ask` card is J3 Bots' own: its answer
 * closes it and wakes the bot. An engine request's answer is recorded on its
 * card before it is sent, so it reaches the engine after a lost reply or a
 * restart; the card shows the answer once the request closes. A secret is
 * never stored: only a marker that a submission may be in flight.
 */
export class Cards extends Context.Service<
  Cards,
  {
    readonly answer: (input: {
      readonly commandId: CommandId;
      readonly entryId: EntryId;
      readonly answer: CardAnswer;
    }) => Effect.Effect<void, NotFound | Conflict | Invalid>;
    readonly provideSecret: (input: {
      readonly entryId: EntryId;
      readonly answer: SecretAnswer;
    }) => Effect.Effect<void, NotFound | Conflict | Invalid>;
    /**
     * Saves a login in the vault, as `vault.save` does, and with `request`
     * shows that bot's save-login card as saved. The card must be one; a card
     * already closed another way stays as it is, and the login is saved all
     * the same, since the operator typed it.
     */
    readonly saveCredential: (input: {
      readonly id: CredentialId;
      readonly draft: CredentialDraft;
      readonly allowedBots: ReadonlyArray<BotId>;
      readonly request: EntryId | null;
    }) => Effect.Effect<Credential, NotFound | Conflict | Invalid>;
    /** Sends every recorded answer the engine has not taken, whose request is still open. */
    readonly respondPending: Effect.Effect<void>;
    /** Learns, for each submission marker a crash or a lost reply left, whether its card closed. */
    readonly checkSubmissions: Effect.Effect<void>;
    /** The responder, for as long as the scope lives. */
    readonly run: Effect.Effect<never>;
  }
>()("@j3-bots/server/turns/Cards") {}

export const layer = Layer.effect(
  Cards,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* Engine;
    const ids = yield* Ids;
    const entries = yield* Entries;
    const receipts = yield* CommandReceipts;
    const observer = yield* Observer;
    const signals = yield* Signals;
    const wakes = yield* Wakes;
    const targetOf = liveTarget(sql);
    const readiness = yield* Readiness;
    const settings = yield* SettingsStore;
    const vault = yield* Vault;
    const transaction = transactional(sql);
    const { sessionLost } = sessionLoss(sql, entries, yield* Ledger, yield* WorkSteps, signals);

    const askCard = SqlSchema.findOneOption({
      Request: EntryId,
      Result: AskCardRow,
      execute: (entryId) => sql`
        SELECT closed_at, audience, audience_room_id, option_values_json
        FROM ask_cards WHERE entry_id = ${entryId}
      `,
    });

    const requestOf = SqlSchema.findOneOption({
      Request: EntryId,
      Result: RequestRow,
      execute: (entryId) => sql`
        SELECT r.entry_id, r.session_id, s.engine_session_id, r.engine_request_id, r.closed_at,
          r.response_json,
          EXISTS (SELECT 1 FROM secret_submissions m WHERE m.entry_id = r.entry_id) AS submitted
        FROM engine_requests r JOIN sessions s ON s.id = r.session_id
        WHERE r.entry_id = ${entryId}
      `,
    });

    // ---- card.answer --------------------------------------------------------------

    /** The operator answered the bot's own question: the card closes and the bot wakes. */
    const answerAsk = Effect.fn("Cards.answerAsk")(function* (
      card: QuestionEntry,
      answer: CardAnswer,
    ) {
      const row = yield* askCard(card.id).pipe(Effect.orDie);
      if (Option.isNone(row)) return yield* new NotFound({ resource: "entry" });
      if (row.value.closed_at !== null || card.status._tag !== "pending") {
        return yield* new Conflict({ reason: "card-closed" });
      }
      if (answer._tag === "approval") return yield* new Invalid({ reason: "answer" });
      if (answer._tag === "question" && !fits(card.questions, answer.answers, card.origin)) {
        return yield* new Invalid({ reason: "answer" });
      }
      if (card.author._tag !== "bot") {
        return yield* Effect.die(new TurnsInvariant({ invariant: "An ask card is a bot's" }));
      }
      // A room's question is answered only while the room takes messages and
      // its bot is still a member: the answer wakes it for the room.
      // Archiving the room or removing the member expires the card in its
      // own transaction; this keeps the rule where the answer is taken.
      const audience = audienceOf(row.value);
      if (audience._tag === "room" && (yield* targetOf(card.author.botId, audience)) === null) {
        return yield* new Conflict({ reason: "room-archived" });
      }
      const status: QuestionEntry["status"] =
        answer._tag === "question"
          ? { _tag: "answered", answers: answer.answers }
          : { _tag: "dismissed" };
      // The answer wakes the bot in an envelope of its own at the least: one
      // too long for that is refused, and the card stays open for another.
      const alone: Wake = {
        at: yield* DateTime.now,
        timeZone: yield* operatorZone(settings),
        sinceLastTurn: [],
        kind: "user",
        answer: askAnswer({
          card,
          status,
          values: row.value.option_values_json,
          // At its widest: the room may be renamed before the answer is dispatched.
          room: row.value.audience_room_id === null ? null : WIDEST_ROOM_NAME,
        }),
        messages: [],
      };
      if (!fitsAlone(alone)) return yield* new Invalid({ reason: "answer-length" });
      yield* entries.update({ ...card, status });
      const [wakeId] = yield* wakes.record([
        {
          botId: card.author.botId,
          kind: "user",
          audience,
          payload: { _tag: "answer", cardId: card.id },
          sourceEntryId: card.id,
          hops: 0,
          retryOf: null,
          cause: { _tag: "operator" },
        },
      ]);
      yield* sql`
        UPDATE ask_cards SET closed_at = ${timeText(yield* DateTime.now)},
          follow_up_wake_id = ${wakeId ?? null}
        WHERE entry_id = ${card.id}
      `.pipe(Effect.orDie);
    });

    /** The answer to an engine request, written before it is sent. */
    const answerRequest = Effect.fn("Cards.answerRequest")(function* (
      entryId: EntryId,
      commandId: CommandId,
      answer: CardAnswer,
    ) {
      const row = yield* requestOf(entryId).pipe(Effect.orDie);
      const found = yield* entries.find(entryId);
      if (Option.isNone(row) || Option.isNone(found))
        return yield* new NotFound({ resource: "entry" });
      const card = found.value.entry;
      if (row.value.closed_at !== null || row.value.response_json !== null) {
        return yield* new Conflict({ reason: "card-closed" });
      }
      const response = responseFor(card, answer);
      if (response === "closed") return yield* new Conflict({ reason: "card-closed" });
      if (response === "invalid") return yield* new Invalid({ reason: "answer" });
      if (response === "not-dismissible") return yield* new Invalid({ reason: "not-dismissible" });
      yield* sql`
        UPDATE engine_requests
        SET response_json = ${yield* encodeResponse(response).pipe(Effect.orDie)}
        WHERE entry_id = ${entryId}
      `.pipe(Effect.orDie);
      yield* sql.afterCommit(signals.responses.fire);
    });

    /**
     * A save-login card takes only a dismissal through `card.answer`: its
     * values go to the vault with `vault.save`. Neither wakes the bot.
     */
    const dismissLogin = Effect.fn("Cards.dismissLogin")(function* (
      card: CredentialRequestEntry,
      answer: CardAnswer,
    ) {
      if (card.status._tag !== "pending") return yield* new Conflict({ reason: "card-closed" });
      if (answer._tag !== "dismiss") return yield* new Invalid({ reason: "answer" });
      yield* entries.update({ ...card, status: { _tag: "dismissed" } });
    });

    /**
     * A connector suggestion takes only a dismissal through `card.answer`, its
     * Not now: final for that connector in the bot's conversation, where the
     * bot's next suggestion of it is refused. Its Connect is `connector.add`
     * or `connector.setBots`. Neither wakes the bot.
     */
    const dismissSuggestion = Effect.fn("Cards.dismissSuggestion")(function* (
      card: ConnectorSuggestionEntry,
      answer: CardAnswer,
    ) {
      if (card.status._tag !== "pending") return yield* new Conflict({ reason: "card-closed" });
      if (answer._tag !== "dismiss") return yield* new Invalid({ reason: "answer" });
      yield* entries.update({ ...card, status: { _tag: "dismissed" } });
    });

    const saveCredential = Effect.fn("Cards.saveCredential")(function* (input: {
      readonly id: CredentialId;
      readonly draft: CredentialDraft;
      readonly allowedBots: ReadonlyArray<BotId>;
      readonly request: EntryId | null;
    }) {
      const request = input.request;
      if (request !== null) {
        const found = yield* entries.find(request);
        if (Option.isNone(found) || found.value.entry._tag !== "credential-request") {
          return yield* new NotFound({ resource: "entry" });
        }
      }
      // The vault is another database: the login is saved first, and the
      // card marked after, so a retry of the same login after a crash between
      // the two still marks it.
      const { credential } = yield* vault.save(input);
      if (request !== null) {
        yield* transaction(
          Effect.gen(function* () {
            const found = yield* entries.find(request);
            if (Option.isNone(found)) return;
            const card = found.value.entry;
            if (card._tag !== "credential-request" || card.status._tag !== "pending") return;
            yield* entries.update({
              ...card,
              status: { _tag: "saved", credentialId: credential.id, name: credential.name },
            });
          }),
        );
      }
      return credential;
    });

    const answer = Effect.fn("Cards.answer")(function* (input: {
      readonly commandId: CommandId;
      readonly entryId: EntryId;
      readonly answer: CardAnswer;
    }) {
      yield* receipts.once({
        commandId: input.commandId,
        method: "card.answer",
        payload: input,
        result: Schema.Void,
        apply: Effect.gen(function* () {
          const found = yield* entries.find(input.entryId);
          if (Option.isNone(found)) return yield* new NotFound({ resource: "entry" });
          const card = found.value.entry;
          if (card._tag === "question" && card.origin === "ask") {
            return yield* answerAsk(card, input.answer);
          }
          if (card._tag === "credential-request") return yield* dismissLogin(card, input.answer);
          if (card._tag === "connector-suggestion") {
            return yield* dismissSuggestion(card, input.answer);
          }
          return yield* answerRequest(input.entryId, input.commandId, input.answer);
        }),
      });
    });

    // ---- The responder ------------------------------------------------------------

    const pendingResponses = SqlSchema.findAll({
      Request: Schema.Void,
      Result: PendingResponse,
      execute: () => sql`
        SELECT r.entry_id, r.session_id, s.engine_session_id, r.engine_request_id,
          r.response_json, r.response_failures, r.response_retry_at
        FROM engine_requests r JOIN sessions s ON s.id = r.session_id
        WHERE r.closed_at IS NULL AND r.response_json IS NOT NULL AND r.response_sent_at IS NULL
          AND s.engine_session_id IS NOT NULL AND s.lost_at IS NULL
        ORDER BY r.rowid
      `,
    })(undefined).pipe(Effect.orDie);

    /** What one answer's send did. */
    type Sent = "done" | "unavailable";

    /** The engine took the answer, or the request is closed: nothing more to send. */
    const taken = Effect.fn("Cards.taken")(function* (entryId: EntryId): Effect.fn.Return<Sent> {
      yield* sql`
        UPDATE engine_requests SET response_sent_at = ${timeText(yield* DateTime.now)},
          response_retry_at = NULL
        WHERE entry_id = ${entryId}
      `.pipe(Effect.orDie);
      return "done";
    });

    /**
     * The engine refused the answer while its request stays open, and keeps
     * that refusal for the answer's key: it is never sent again. The card
     * closes as `refused`, saying so, and takes no other answer; the turn
     * waits until it ends or is stopped. The request is closed here, so its
     * engine record closing later changes nothing.
     */
    const rejected = Effect.fn("Cards.rejected")(function* (
      pending: typeof PendingResponse.Type,
    ): Effect.fn.Return<Sent> {
      yield* Effect.logWarning(
        "The engine refused an answer; its card closes, and its turn waits for a Stop",
      ).pipe(Effect.annotateLogs({ entryId: pending.entry_id }));
      yield* transaction(
        Effect.gen(function* () {
          const now = timeText(yield* DateTime.now);
          yield* sql`
            UPDATE engine_requests SET closed_at = ${now}, response_sent_at = ${now},
              response_retry_at = NULL
            WHERE entry_id = ${pending.entry_id} AND closed_at IS NULL
          `.pipe(Effect.orDie);
          const found = yield* entries.find(pending.entry_id);
          if (Option.isNone(found)) return;
          const card = found.value.entry;
          if (card._tag === "question" || card._tag === "approval") {
            yield* entries.update({ ...card, status: { _tag: "refused" } });
          }
        }),
      );
      return "done";
    });

    /** The answer waits until `next` before it is sent again. */
    const later = Effect.fn("Cards.later")(function* (
      pending: typeof PendingResponse.Type,
      next: DateTime.Utc,
    ): Effect.fn.Return<Sent> {
      yield* sql`
        UPDATE engine_requests SET response_failures = ${pending.response_failures + 1},
          response_retry_at = ${timeText(next)}
        WHERE entry_id = ${pending.entry_id}
      `.pipe(Effect.orDie);
      return "done";
    });

    /**
     * The reply was lost: the answer is sent again with backoff for as long
     * as its request is open. Its key makes every send of it one answer.
     */
    const unanswered = Effect.fn("Cards.unanswered")(function* (
      pending: typeof PendingResponse.Type,
    ) {
      const now = yield* DateTime.now;
      return yield* later(
        pending,
        DateTime.addDuration(now, recoveryBackoff(pending.response_failures + 1)),
      );
    });

    const respondOne = (pending: typeof PendingResponse.Type) =>
      engine
        .respond({
          key: answerKey(pending.entry_id),
          sessionId: pending.engine_session_id,
          requestId: pending.engine_request_id,
          response: pending.response_json,
        })
        .pipe(
          Effect.andThen(taken(pending.entry_id)),
          Effect.catchTags({
            RequestClosed: () => taken(pending.entry_id),
            AnswerRejected: () => rejected(pending),
            SessionNotFound: () =>
              transaction(sessionLost(pending.session_id)).pipe(Effect.as<Sent>("done")),
            EngineIndeterminate: () => unanswered(pending),
            EngineUnavailable: () => Effect.succeed<Sent>("unavailable"),
            EngineIncompatible: () => Effect.succeed<Sent>("unavailable"),
          }),
        );

    /**
     * One answer at a time: a defect is logged and that answer is sent again
     * on the backoff of a lost reply, while the pass goes on with the others.
     */
    const supervised = (pending: typeof PendingResponse.Type) =>
      respondOne(pending).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logError("An answer could not be sent; it is tried again later", cause).pipe(
              Effect.andThen(unanswered(pending)),
            ),
        ),
      );

    /**
     * The responder's pass: a reconciler over the answers the engine has not
     * taken. The request's events show how it closed; the answer's key makes
     * every send of it the same command.
     */
    const respondPass: Effect.Effect<Pass> = yield* onePassAtATime(
      Effect.gen(function* () {
        const outcome = passOutcome();
        const now = yield* DateTime.now;
        for (const pending of yield* pendingResponses) {
          if (pending.response_retry_at !== null) {
            if (DateTime.isGreaterThan(pending.response_retry_at, now)) continue;
          }
          const sent = yield* supervised(pending);
          if (sent === "unavailable") return { _tag: "unavailable" } as const;
        }
        for (const pending of yield* pendingResponses) outcome.until(pending.response_retry_at);
        return outcome.done();
      }).pipe(Effect.withSpan("Cards.respondPending")),
    );

    const respondPending = Effect.asVoid(respondPass);

    // ---- secret.provide -----------------------------------------------------------

    const requireOpenSecret = Effect.fn("Cards.requireOpenSecret")(function* (entryId: EntryId) {
      const row = yield* requestOf(entryId).pipe(Effect.orDie);
      const found = yield* entries.find(entryId);
      if (
        Option.isNone(row) ||
        Option.isNone(found) ||
        found.value.entry._tag !== "secret-request"
      ) {
        return yield* new NotFound({ resource: "entry" });
      }
      if (row.value.closed_at !== null || found.value.entry.status !== "pending") {
        return yield* new Conflict({ reason: "card-closed" });
      }
      return row.value;
    });

    /** What the engine knows of a card a submission may have reached. */
    const learn = Effect.fn("Cards.learn")(function* (row: RequestRow) {
      if (row.engine_session_id === null) return;
      yield* observer
        .synchronize(row.session_id, row.engine_session_id)
        .pipe(Effect.mapError(() => new Conflict({ reason: "engine-unavailable" })));
    });

    /**
     * Each card's secret lifecycle runs alone: a submission, and the startup
     * check of an earlier one, never interleave on one card. The marker names
     * its submission too, so a cleanup removes only the marker it read.
     */
    const perCard = keyedLock();

    const clearMarker = (entryId: EntryId, submissionId: string) =>
      sql`
        DELETE FROM secret_submissions WHERE entry_id = ${entryId} AND submission_id = ${submissionId}
      `.pipe(Effect.orDie);

    const submit = Effect.fn("Cards.submit")(function* (input: {
      readonly entryId: EntryId;
      readonly answer: SecretAnswer;
    }) {
      let row = yield* requireOpenSecret(input.entryId);
      if (row.submitted) {
        // A submission whose answer was lost may have closed it.
        yield* learn(row);
        row = yield* requireOpenSecret(input.entryId);
      }
      const sessionId = row.engine_session_id;
      if (sessionId === null) return yield* new Conflict({ reason: "card-closed" });
      const submissionId = yield* ids.make("submission");
      yield* sql`
        INSERT INTO secret_submissions (entry_id, submission_id, submitted_at)
        VALUES (${input.entryId}, ${submissionId}, ${timeText(yield* DateTime.now)})
        ON CONFLICT (entry_id) DO UPDATE
        SET submission_id = excluded.submission_id, submitted_at = excluded.submitted_at
      `.pipe(Effect.orDie);
      const cleared = clearMarker(input.entryId, submissionId);
      yield* engine
        .respondSecret({ sessionId, requestId: row.engine_request_id, answer: input.answer })
        .pipe(
          Effect.tap(() => cleared),
          Effect.catchTags({
            // Another answer, or the turn's end, closed it first.
            RequestClosed: () => Effect.andThen(cleared, new Conflict({ reason: "card-closed" })),
            SessionNotFound: () => Effect.andThen(cleared, new Conflict({ reason: "card-closed" })),
            // Nothing was sent.
            EngineUnavailable: () =>
              Effect.andThen(cleared, new Conflict({ reason: "engine-unavailable" })),
            EngineIncompatible: () =>
              Effect.andThen(cleared, new Conflict({ reason: "engine-unavailable" })),
            // It may have landed: the marker stays, and the next call learns.
            EngineIndeterminate: () => new Conflict({ reason: "engine-unavailable" }),
          }),
        );
    });

    const provideSecret = (input: { readonly entryId: EntryId; readonly answer: SecretAnswer }) =>
      perCard.run(input.entryId)(submit(input));

    const markers = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ entry_id: EntryId, submission_id: Schema.String }),
      execute: () => sql`SELECT entry_id, submission_id FROM secret_submissions`,
    });

    /** Settles one marker left by a submission whose answer was lost. */
    const checkSubmission = Effect.fn("Cards.checkSubmission")(function* (
      entryId: EntryId,
      submissionId: string,
    ) {
      const row = yield* requestOf(entryId).pipe(Effect.orDie);
      if (Option.isNone(row)) return;
      // Bounded: `synchronize` fails at its deadline, and the marker stays.
      const learned = yield* learn(row.value).pipe(Effect.option);
      if (Option.isNone(learned)) return;
      // Applying the events closed it if it closed; one still open takes a value again.
      const now = yield* requestOf(entryId).pipe(Effect.orDie);
      if (Option.isSome(now) && now.value.closed_at === null) {
        yield* clearMarker(entryId, submissionId);
      }
    });

    const checkSubmissions = Effect.gen(function* () {
      for (const { entry_id, submission_id } of yield* markers(undefined).pipe(Effect.orDie)) {
        yield* perCard.run(entry_id)(checkSubmission(entry_id, submission_id));
      }
    }).pipe(Effect.withSpan("Cards.checkSubmissions"));

    const run = reconcile({
      name: "The responder",
      pass: respondPass,
      signal: signals.responses,
      readiness,
    });

    return Cards.of({
      answer,
      provideSecret,
      saveCredential,
      respondPending,
      checkSubmissions,
      run,
    });
  }),
);
