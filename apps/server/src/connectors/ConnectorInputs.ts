// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  answersFields,
  type BotId,
  type CommandId,
  Conflict,
  type ConnectorInputEntry,
  type Elicitation,
  type ElicitationAnswer,
  EntryId,
  Invalid,
  NotFound,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { CommandReceipts } from "../commands/CommandReceipts.ts";
import { Entries } from "../entries/Entries.ts";
import type { ConnectorRef } from "./Connectors.ts";

/**
 * What a connector's server asks the operator in the middle of a bot's call
 * (MCP elicitation, decision 0047). Each request is a `connector-input` card
 * in the conversation of the bot whose call asked, which the call waits on:
 * the operator's answer goes back to the server only, and the card closes as
 * `expired` when the call ends first. A call does not outlive the server, so
 * a card still open when the server starts is expired then.
 */
export class ConnectorInputs extends Context.Service<
  ConnectorInputs,
  {
    /** Shows `request` in `botId`'s conversation and waits for the operator's answer. */
    readonly ask: (input: {
      readonly botId: BotId;
      readonly connector: ConnectorRef;
      readonly request: Elicitation;
    }) => Effect.Effect<ElicitationAnswer>;
    readonly answer: (input: {
      readonly commandId: CommandId;
      readonly entryId: EntryId;
      readonly answer: ElicitationAnswer;
    }) => Effect.Effect<void, NotFound | Invalid | Conflict>;
  }
>()("@j3-bots/server/connectors/ConnectorInputs") {}

const OpenCard = Schema.Struct({ id: EntryId });
const decodeOpenCards = Schema.decodeUnknownEffect(Schema.Array(OpenCard));

const statusOf = (answer: ElicitationAnswer): ConnectorInputEntry["status"] => ({
  _tag: "answered",
  action: answer._tag,
});

export const layer = Layer.effect(
  ConnectorInputs,
  Effect.gen(function* () {
    const entries = yield* Entries;
    const receipts = yield* CommandReceipts;
    const sql = yield* SqlClient.SqlClient;
    /** The calls waiting on a card, by the card. */
    const waiting = yield* Ref.make<ReadonlyMap<EntryId, Deferred.Deferred<ElicitationAnswer>>>(
      new Map(),
    );

    const forget = (id: EntryId) =>
      Ref.update(waiting, (all) => {
        const next = new Map(all);
        next.delete(id);
        return next;
      });

    /** Closes the card with `status` if it is still open; whether this did. */
    const close = Effect.fn("ConnectorInputs.close")(function* (
      id: EntryId,
      status: ConnectorInputEntry["status"],
    ) {
      const found = yield* entries.find(id);
      if (Option.isNone(found)) return false;
      const card = found.value.entry;
      if (card._tag !== "connector-input" || card.status._tag !== "pending") return false;
      yield* entries.update({ ...card, status });
      return true;
    });

    // A call does not survive the server: a card left open by one is closed.
    const left = yield* sql`
      SELECT id FROM entries
      WHERE kind = 'connector-input' AND json_extract(body_json, '$.status._tag') = 'pending'
    `.pipe(Effect.flatMap(decodeOpenCards), Effect.orDie);
    for (const { id } of left) yield* close(id, { _tag: "expired" });

    const ask = Effect.fn("ConnectorInputs.ask")(function* (input: {
      readonly botId: BotId;
      readonly connector: ConnectorRef;
      readonly request: Elicitation;
    }) {
      const answered = yield* Deferred.make<ElicitationAnswer>();
      return yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          const card = yield* entries.append({
            target: { _tag: "conversation", botId: input.botId },
            entry: {
              _tag: "connector-input",
              author: { _tag: "bot", botId: input.botId },
              connectorId: input.connector.id,
              name: input.connector.name,
              glyph: input.connector.glyph,
              request: input.request,
              status: { _tag: "pending" },
            },
          });
          yield* Ref.update(waiting, (all) => new Map(all).set(card.id, answered));
          return card.id;
        }),
        () => Deferred.await(answered),
        // The call ended, answered or not: a card still open can no longer be answered.
        (id) => Effect.andThen(forget(id), close(id, { _tag: "expired" })),
      );
    });

    const answer = Effect.fn("ConnectorInputs.answer")(function* (input: {
      readonly commandId: CommandId;
      readonly entryId: EntryId;
      readonly answer: ElicitationAnswer;
    }) {
      const found = yield* entries.find(input.entryId);
      if (Option.isNone(found)) return yield* new NotFound({ resource: "entry" });
      const card = found.value.entry;
      if (card._tag !== "connector-input") return yield* new Invalid({ reason: "answer" });
      if (
        input.answer._tag === "accept" &&
        card.request._tag === "form" &&
        !answersFields(card.request.fields, input.answer.content)
      ) {
        return yield* new Invalid({ reason: "connector-input" });
      }
      // The values a form takes are the operator's, for the server only: the
      // receipt keeps what was answered, never what was typed.
      yield* receipts.once({
        commandId: input.commandId,
        method: "card.answer",
        payload: { entryId: input.entryId, action: input.answer._tag },
        result: Schema.Void,
        apply: Effect.gen(function* () {
          const open = (yield* Ref.get(waiting)).has(input.entryId);
          if (open && (yield* close(input.entryId, statusOf(input.answer)))) return;
          // Two of the operator's devices gave the same answer at once.
          const closed = yield* entries.find(input.entryId);
          const same = Option.exists(
            closed,
            ({ entry }) =>
              entry._tag === "connector-input" &&
              entry.status._tag === "answered" &&
              entry.status.action === input.answer._tag,
          );
          if (!same) return yield* new Conflict({ reason: "card-closed" });
        }),
      });
      // Once the card says so: the call goes on with the first answer given.
      const call = (yield* Ref.get(waiting)).get(input.entryId);
      if (call !== undefined) yield* Deferred.succeed(call, input.answer);
    });

    return ConnectorInputs.of({ ask, answer });
  }),
);
