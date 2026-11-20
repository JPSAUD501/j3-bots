// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CommandId,
  Conflict,
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
import { json, Time, timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { AudienceColumn, audienceOf, StoredResponse } from "./model.ts";
import { Observer } from "./Observer.ts";
import { Signals } from "./Signals.ts";
import { Wakes } from "./Wakes.ts";

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
});

const RequestRow = Schema.Struct({
  entry_id: EntryId,
  session_id: Schema.String,
  engine_session_id: Schema.NullOr(SessionId),
  engine_request_id: RequestId,
  closed_at: Schema.NullOr(Time),
  response_json: Schema.NullOr(json(StoredResponse)),
  submitted: Schema.BooleanFromBit,
});
type RequestRow = typeof RequestRow.Type;

const PendingResponse = Schema.Struct({
  entry_id: EntryId,
  engine_session_id: SessionId,
  engine_request_id: RequestId,
  response_json: json(StoredResponse),
});

const encodeResponse = Schema.encodeEffect(json(StoredResponse));

/** The engine key of the answer to a card: one card takes one answer. */
const answerKey = (entryId: EntryId) => IdempotencyKey.make(`answer:${entryId}`);

/** Whether answers fit the card's questions: known options, one unless several are allowed, text only where accepted. */
const fits = (questions: ReadonlyArray<Question>, answers: QuestionAnswers): boolean => {
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
      (answer.optionIds.length > 0 || text.length > 0)
    );
  });
};

/** What the engine is sent for an answer to its request's card, if the answer fits the card. */
const responseFor = (card: Entry, answer: CardAnswer): StoredResponse | "invalid" | "closed" => {
  switch (card._tag) {
    case "approval":
      if (card.status._tag !== "pending") return "closed";
      if (answer._tag !== "approval") return "invalid";
      if (answer.decision === "allow-session" && !card.allowsSession) return "invalid";
      return { _tag: "approval", decision: answer.decision };
    case "question":
      if (card.status._tag !== "pending") return "closed";
      if (answer._tag === "dismiss") return { _tag: "dismiss" };
      return answer._tag === "question" && fits(card.questions, answer.answers)
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
    /** Sends every recorded answer whose request is still open. */
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
    const transaction = transactional(sql);
    const engine = yield* Engine;
    const entries = yield* Entries;
    const receipts = yield* CommandReceipts;
    const observer = yield* Observer;
    const signals = yield* Signals;
    const wakes = yield* Wakes;

    const askCard = SqlSchema.findOneOption({
      Request: EntryId,
      Result: AskCardRow,
      execute: (entryId) => sql`
        SELECT closed_at, audience, audience_room_id FROM ask_cards WHERE entry_id = ${entryId}
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
      if (answer._tag === "question" && !fits(card.questions, answer.answers)) {
        return yield* new Invalid({ reason: "answer" });
      }
      yield* entries.update({
        ...card,
        status:
          answer._tag === "question"
            ? { _tag: "answered", answers: answer.answers }
            : { _tag: "dismissed" },
      });
      if (card.author._tag !== "bot") return yield* Effect.die("An ask card is a bot's");
      const [wakeId] = yield* wakes.record([
        {
          botId: card.author.botId,
          kind: "user",
          audience: audienceOf(row.value),
          payload: { _tag: "answer", cardId: card.id },
          sourceEntryId: card.id,
          hops: 0,
          retryOf: null,
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
      yield* sql`
        UPDATE engine_requests SET response_key = ${commandId},
          response_json = ${yield* encodeResponse(response).pipe(Effect.orDie)}
        WHERE entry_id = ${entryId}
      `.pipe(Effect.orDie);
      yield* sql.afterCommit(signals.responses.fire);
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
          return yield* answerRequest(input.entryId, input.commandId, input.answer);
        }),
      });
    });

    // ---- The responder ------------------------------------------------------------

    const pendingResponses = SqlSchema.findAll({
      Request: Schema.Void,
      Result: PendingResponse,
      execute: () => sql`
        SELECT r.entry_id, s.engine_session_id, r.engine_request_id, r.response_json
        FROM engine_requests r JOIN sessions s ON s.id = r.session_id
        WHERE r.closed_at IS NULL AND r.response_json IS NOT NULL
          AND s.engine_session_id IS NOT NULL
      `,
    });

    const respondPending = Effect.gen(function* () {
      for (const pending of yield* pendingResponses(undefined).pipe(Effect.orDie)) {
        const response = pending.response_json;
        // The request's events show how it closed; a refusal or a lost reply
        // leaves it to the next ready edge.
        yield* engine
          .respond({
            key: answerKey(pending.entry_id),
            sessionId: pending.engine_session_id,
            requestId: pending.engine_request_id,
            response,
          })
          .pipe(Effect.ignore);
      }
    }).pipe(Effect.withSpan("Cards.respondPending"));

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

    const clearMarker = (entryId: EntryId) =>
      sql`DELETE FROM secret_submissions WHERE entry_id = ${entryId}`.pipe(Effect.orDie);

    const provideSecret = Effect.fn("Cards.provideSecret")(function* (input: {
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
      yield* sql`
        INSERT INTO secret_submissions (entry_id, submitted_at)
        VALUES (${input.entryId}, ${timeText(yield* DateTime.now)})
        ON CONFLICT (entry_id) DO UPDATE SET submitted_at = excluded.submitted_at
      `.pipe(Effect.orDie);
      yield* engine
        .respondSecret({ sessionId, requestId: row.engine_request_id, answer: input.answer })
        .pipe(
          Effect.tap(() => clearMarker(input.entryId)),
          Effect.catchTags({
            // Another answer, or the turn's end, closed it first.
            RequestClosed: () =>
              Effect.andThen(clearMarker(input.entryId), new Conflict({ reason: "card-closed" })),
            SessionNotFound: () =>
              Effect.andThen(clearMarker(input.entryId), new Conflict({ reason: "card-closed" })),
            // Nothing was sent.
            EngineUnavailable: () =>
              Effect.andThen(
                clearMarker(input.entryId),
                new Conflict({ reason: "engine-unavailable" }),
              ),
            EngineIncompatible: () =>
              Effect.andThen(
                clearMarker(input.entryId),
                new Conflict({ reason: "engine-unavailable" }),
              ),
            // It may have landed: the marker stays, and the next call learns.
            EngineIndeterminate: () => new Conflict({ reason: "engine-unavailable" }),
          }),
        );
    });

    const markers = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ entry_id: EntryId }),
      execute: () => sql`SELECT entry_id FROM secret_submissions`,
    });

    const checkSubmissions = Effect.gen(function* () {
      for (const { entry_id } of yield* markers(undefined).pipe(Effect.orDie)) {
        const row = yield* requestOf(entry_id).pipe(Effect.orDie);
        if (Option.isNone(row)) continue;
        const learned = yield* learn(row.value).pipe(Effect.option);
        if (Option.isNone(learned)) continue;
        // Applying the events closed it if it closed; one still open takes a value again.
        yield* transaction(
          Effect.gen(function* () {
            const now = yield* requestOf(entry_id).pipe(Effect.orDie);
            if (Option.isSome(now) && now.value.closed_at === null) yield* clearMarker(entry_id);
          }),
        ).pipe(Effect.orDie);
      }
    }).pipe(Effect.withSpan("Cards.checkSubmissions"));

    const run = Effect.gen(function* () {
      yield* signals.responses.next;
      yield* respondPending;
    }).pipe(Effect.forever);

    return Cards.of({ answer, provideSecret, respondPending, checkSubmissions, run });
  }),
);
