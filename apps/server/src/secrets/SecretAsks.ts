// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type Conflict,
  EntryId,
  Invalid,
  NotFound,
  RoomId,
  type Secret,
  type SecretAccess,
  type SecretAskEntry,
  type SecretDraft,
  type SecretId,
  SecretName,
  type SecretRequestFieldId,
} from "@j3-bots/contracts";
import type * as Redacted from "effect/Redacted";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Entries } from "../entries/Entries.ts";
import { timeText } from "../persistence/columns.ts";
import { transactional } from "../persistence/transaction.ts";
import { AudienceColumn, audienceOf, DispatchSeq, TurnsInvariant } from "../turns/model.ts";
import { Wakes } from "../turns/Wakes.ts";
import { Secrets } from "./Secrets.ts";

/** How long an ask for a secret waits for the operator before it expires. */
export const SECRET_ASK_WAIT = Duration.hours(24);

/** How often the server looks for asks past their wait. */
const SWEEP_EVERY = Duration.minutes(1);

/** How an ask closed. */
type Closing = "saved" | "declined" | "expired";

const ClosedAsk = Schema.Struct({
  bot_id: BotId,
  audience: AudienceColumn,
  audience_room_id: Schema.NullOr(RoomId),
  origin_seq: Schema.NullOr(DispatchSeq),
});

const decodeName = Schema.decodeUnknownOption(SecretName);

/**
 * A bot's asks for a secret (`docs/architecture/server.md`, "Secrets"): the
 * `secret-ask` card `ask_for_secret` shows in the bot's conversation closes
 * once, saved from the card, declined, or expired past its wait, and each
 * close wakes the bot for the audience of the turn that asked, with the
 * secret's reference, or each one's of an ask for several values. The bot never gets a value: the operator's values go
 * from the client to `Secrets`.
 */
export class SecretAsks extends Context.Service<
  SecretAsks,
  {
    /**
     * Adds a secret, as `secrets.add` does; with `request`, it answers that
     * bot's ask, whose name and kind it must have: the card closes as saved,
     * its bot may use the secret whatever `access` says, and it is woken. A
     * card already closed another way stays as it is, and the secret is
     * added all the same, since the operator typed it.
     */
    readonly add: (input: {
      readonly id: SecretId;
      readonly name: SecretName;
      readonly draft: SecretDraft;
      readonly access: SecretAccess;
      readonly request: EntryId | null;
    }) => Effect.Effect<Secret, Conflict | Invalid | NotFound>;
    /**
     * Answers a bot's ask for several values (`values`): each is added as a
     * single value under the name the card gives it, its bot may use them
     * whatever `access` says, and the card closes as saved and wakes it once
     * every one is. Every value must be given, once.
     */
    readonly addFromAsk: (input: {
      readonly request: EntryId;
      readonly access: SecretAccess;
      readonly values: ReadonlyArray<{
        readonly field: SecretRequestFieldId;
        readonly id: SecretId;
        readonly value: Redacted.Redacted<string>;
      }>;
    }) => Effect.Effect<ReadonlyArray<Secret>, Conflict | Invalid | NotFound>;
    /**
     * The operator declines the ask, in the caller's transaction: the card
     * closes and the bot is woken. False when it had closed already.
     */
    readonly decline: (card: SecretAskEntry) => Effect.Effect<boolean>;
    /** The expiry sweep, for as long as the scope lives. */
    readonly run: Effect.Effect<never>;
  }
>()("@j3-bots/server/secrets/SecretAsks") {}

/** `access` with the bot that asked in it: it may always use what it asked for. */
const withAsker = (access: SecretAccess, card: SecretAskEntry): SecretAccess => {
  const botId = card.author.botId;
  return access._tag === "every-bot" || access.botIds.includes(botId)
    ? access
    : { _tag: "bots", botIds: [...access.botIds, botId] };
};

export const layer = Layer.effect(
  SecretAsks,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entries = yield* Entries;
    const wakes = yield* Wakes;
    const secrets = yield* Secrets;
    const transaction = transactional(sql);

    const closeRow = SqlSchema.findAll({
      Request: Schema.Struct({
        entryId: EntryId,
        at: Schema.String,
        closing: Schema.Literals(["saved", "declined", "expired"]),
      }),
      Result: ClosedAsk,
      execute: ({ entryId, at, closing }) => sql`
        UPDATE secret_asks SET closed_at = ${at}, closing = ${closing}
        WHERE entry_id = ${entryId} AND closed_at IS NULL
        RETURNING bot_id, audience, audience_room_id, origin_seq
      `,
    });

    /**
     * Closes the ask, if it is still open, and wakes its bot: in the caller's
     * transaction. A save or a decline is the operator's word, which a Stop
     * never cancels ahead of time; an expiry continues the work that asked,
     * so a Stop of that work leaves the bot asleep.
     */
    const close = Effect.fn("SecretAsks.close")(function* (entryId: EntryId, closing: Closing) {
      const [row] = yield* closeRow({ entryId, at: timeText(yield* DateTime.now), closing }).pipe(
        Effect.orDie,
      );
      if (row === undefined) return false;
      const found = yield* entries.find(entryId);
      if (Option.isNone(found) || found.value.entry._tag !== "secret-ask") {
        return yield* Effect.die(
          new TurnsInvariant({ invariant: "An ask for a secret's entry is a secret-ask one" }),
        );
      }
      const card = found.value.entry;
      const name = decodeName(card.name);
      const alongside = (card.values ?? []).slice(1).flatMap((value) => {
        const decoded = decodeName(value.name);
        return Option.isSome(decoded) ? [decoded.value] : [];
      });
      if (Option.isNone(name)) {
        return yield* Effect.die(
          new TurnsInvariant({
            invariant: "An open ask for a secret names one by a secret's name",
          }),
        );
      }
      yield* entries.update({ ...card, status: { _tag: closing } });
      const [wakeId] = yield* wakes.record([
        {
          botId: row.bot_id,
          kind: "system",
          audience: audienceOf(row),
          payload: {
            _tag: "secret-ask",
            cardId: card.id,
            outcome: closing,
            name: name.value,
            ...(alongside.length > 0 ? { alongside } : {}),
          },
          sourceEntryId: card.id,
          hops: 0,
          retryOf: null,
          cause:
            closing !== "expired" || row.origin_seq === null
              ? { _tag: "operator" }
              : { _tag: "work", seq: row.origin_seq },
        },
      ]);
      yield* sql`
        UPDATE secret_asks SET follow_up_wake_id = ${wakeId ?? null} WHERE entry_id = ${entryId}
      `.pipe(Effect.orDie);
      return true;
    });

    const saving = Semaphore.makeUnsafe(1);

    const add = Effect.fn("SecretAsks.add")(function* (input: {
      readonly id: SecretId;
      readonly name: SecretName;
      readonly draft: SecretDraft;
      readonly access: SecretAccess;
      readonly request: EntryId | null;
    }) {
      const request = input.request;
      if (request === null) return (yield* secrets.add(input)).secret;
      const found = yield* entries.find(request);
      if (Option.isNone(found) || found.value.entry._tag !== "secret-ask") {
        return yield* new NotFound({ resource: "entry" });
      }
      const card = found.value.entry;
      // An ask for several values is answered with all of them (`addFromAsk`).
      if (
        card.values !== undefined ||
        card.name !== input.name ||
        card.secret._tag !== input.draft._tag
      ) {
        return yield* new Invalid({ reason: "answer" });
      }
      const access = withAsker(input.access, card);
      // The secrets are another database: the secret is added first, with
      // the card it answers, and the card closed after. A crash between the
      // two leaves the card open: a device that sends the answer again, under
      // any id, closes it, and so does the next sweep.
      // One save or sweep at a time, so a sweep never expires a card whose
      // secret a save added after the sweep looked.
      return yield* saving.withPermit(
        Effect.gen(function* () {
          const { secret } = yield* secrets.add({ ...input, access, askedIn: card.id });
          yield* transaction(close(card.id, "saved"));
          return secret;
        }),
      );
    });

    const addFromAsk = Effect.fn("SecretAsks.addFromAsk")(function* (input: {
      readonly request: EntryId;
      readonly access: SecretAccess;
      readonly values: ReadonlyArray<{
        readonly field: SecretRequestFieldId;
        readonly id: SecretId;
        readonly value: Redacted.Redacted<string>;
      }>;
    }) {
      const found = yield* entries.find(input.request);
      if (Option.isNone(found) || found.value.entry._tag !== "secret-ask") {
        return yield* new NotFound({ resource: "entry" });
      }
      const card = found.value.entry;
      const asked = card.values;
      const given = new Map(input.values.map((value) => [value.field, value]));
      if (
        asked === undefined ||
        given.size !== input.values.length ||
        given.size !== asked.length ||
        new Set(input.values.map((value) => value.id)).size !== input.values.length
      ) {
        return yield* new Invalid({ reason: "answer" });
      }
      const answers: Array<{
        readonly id: SecretId;
        readonly name: SecretName;
        readonly value: Redacted.Redacted<string>;
      }> = [];
      for (const value of asked) {
        const answer = given.get(value.id);
        const name = decodeName(value.name);
        if (answer === undefined || Option.isNone(name)) {
          return yield* new Invalid({ reason: "answer" });
        }
        answers.push({ id: answer.id, name: name.value, value: answer.value });
      }
      const access = withAsker(input.access, card);
      // As for one secret: the values are added first, with the card they
      // answer, and the card closed after; one value the operator already
      // gave is not added twice when they send them again.
      return yield* saving.withPermit(
        Effect.gen(function* () {
          const added: Array<Secret> = [];
          for (const answer of answers) {
            const { secret } = yield* secrets.add({
              id: answer.id,
              name: answer.name,
              draft: { _tag: "value", value: answer.value },
              access,
              askedIn: card.id,
            });
            added.push(secret);
          }
          yield* transaction(close(card.id, "saved"));
          return added;
        }),
      );
    });

    const decline = (card: SecretAskEntry) => close(card.id, "declined");

    const openPastWait = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ entry_id: EntryId }),
      execute: (now) => sql`
        SELECT entry_id FROM secret_asks WHERE closed_at IS NULL AND expires_at <= ${now}
      `,
    });

    const openAsks = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ entry_id: EntryId }),
      execute: () => sql`SELECT entry_id FROM secret_asks WHERE closed_at IS NULL`,
    });

    /**
     * Closes as saved the asks whose secret was added before the server
     * stopped short of closing their card, then as expired those that waited
     * past `SECRET_ASK_WAIT`. While the secrets cannot be read, nothing can
     * be saved from a card either, and none closes as saved.
     */
    const sweep = saving.withPermit(
      Effect.gen(function* () {
        const open = yield* openAsks(undefined).pipe(Effect.orDie);
        if (open.length === 0) return;
        const saved = yield* secrets
          .askedIn(open.map(({ entry_id }) => entry_id))
          .pipe(Effect.orElseSucceed((): ReadonlyMap<string, number> => new Map()));
        for (const { entry_id } of open) {
          const added = saved.get(entry_id) ?? 0;
          if (added === 0) continue;
          // An ask for several values is saved once every one of them is.
          const found = yield* entries.find(entry_id);
          const card = Option.filter(
            Option.map(found, ({ entry }) => entry),
            (entry): entry is SecretAskEntry => entry._tag === "secret-ask",
          );
          const asked = Option.match(card, {
            onNone: () => 1,
            onSome: (c) => c.values?.length ?? 1,
          });
          if (added >= asked) yield* transaction(close(entry_id, "saved"));
        }
        const due = yield* openPastWait(timeText(yield* DateTime.now)).pipe(Effect.orDie);
        for (const { entry_id } of due) yield* transaction(close(entry_id, "expired"));
      }),
    );

    const run = Stream.tick(SWEEP_EVERY).pipe(
      Stream.runForEach(() => sweep),
      Effect.andThen(Effect.never),
    );

    return SecretAsks.of({ add, addFromAsk, decline, run });
  }),
);
