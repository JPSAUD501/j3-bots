// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type CommandId,
  DeviceId,
  DeviceToken,
  type EntryId,
  type EntryTarget,
  J3Rpcs,
  NotFound,
} from "@j3-bots/contracts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ClientRuntime from "../src/client.ts";
import { Connection, type ConnectionState } from "../src/connection/Connection.ts";
import { Actions, cardAction } from "../src/intents/Actions.ts";
import { CredentialStore, type DeviceCredential } from "../src/ports.ts";
import { waitFor } from "../src/Store.ts";
import {
  type ConversationState,
  Conversations,
  messageStatus,
} from "../src/stores/Conversations.ts";
import { Devices } from "../src/stores/Devices.ts";
import { Roster } from "../src/stores/Roster.ts";
import * as TestPlatform from "./platform.ts";

// The real server's routes, socket and part-1 handlers, over the in-memory
// engine and a temporary database. The RPCs it does not serve yet are answered
// by the fakes below, which keep the contract: a command id is applied once.

/** What the fakes record, and a gate that holds them until the test opens it. */
class Fakes extends Context.Service<
  Fakes,
  {
    readonly gate: Latch.Latch;
    /** Every `message.send` the server received, by command id, as it arrives. */
    readonly sends: Queue.Queue<CommandId>;
    /** Every `card.answer` the server received. */
    readonly answers: Queue.Queue<CommandId>;
  }
>()("@j3-bots/client-runtime/test/client.test/Fakes") {}

const fakes = Layer.effect(
  Fakes,
  Effect.gen(function* () {
    return Fakes.of({
      gate: yield* Latch.make(true),
      sends: yield* Queue.unbounded<CommandId>(),
      answers: yield* Queue.unbounded<CommandId>(),
    });
  }),
);

const notFaked = () => Effect.die("Not faked");

const unserved = Layer.mergeAll(
  J3Rpcs.toLayerHandler(
    "message.send",
    Effect.gen(function* () {
      const { gate, sends } = yield* Fakes;
      const entries = yield* Server.Entries;
      const applied = new Map<CommandId, EntryId>();
      const once = Semaphore.makeUnsafe(1);
      return ({ commandId, target, text, mentions }) =>
        Effect.gen(function* () {
          yield* Queue.offer(sends, commandId);
          yield* gate.await;
          return yield* once.withPermits(1)(
            Effect.gen(function* () {
              const known = applied.get(commandId);
              if (known !== undefined) return known;
              const entry = yield* entries.append({
                target,
                commandId,
                entry: {
                  _tag: "message",
                  author: { _tag: "operator" },
                  text,
                  attachments: [],
                  mentions: mentions ?? { _tag: "bots", ids: [] },
                  delivery: { _tag: "pending" },
                  commandId,
                },
              });
              applied.set(commandId, entry.id);
              return entry.id;
            }),
          );
        });
    }),
  ),
  J3Rpcs.toLayerHandler(
    "card.answer",
    Effect.gen(function* () {
      const { gate, answers } = yield* Fakes;
      const entries = yield* Server.Entries;
      return ({ commandId, entryId, answer }) =>
        Effect.gen(function* () {
          yield* Queue.offer(answers, commandId);
          yield* gate.await;
          const found = yield* entries.find(entryId);
          if (Option.isNone(found) || found.value.entry._tag !== "question") {
            return yield* new NotFound({ resource: "entry" });
          }
          yield* entries.update({
            ...found.value.entry,
            status:
              answer._tag === "question"
                ? { _tag: "answered", answers: answer.answers }
                : { _tag: "dismissed" },
          });
        });
    }),
  ),
  J3Rpcs.toLayerHandler("client.view", () => Effect.void),
  J3Rpcs.toLayerHandler("notifications.subscribe", () => Stream.never),
  J3Rpcs.toLayerHandler("entries.workSteps", () => Stream.die("Not faked")),
  J3Rpcs.toLayerHandler("secret.provide", notFaked),
  J3Rpcs.toLayerHandler("notice.retry", notFaked),
  J3Rpcs.toLayerHandler("message.retry", notFaked),
  J3Rpcs.toLayerHandler("bot.stop", notFaked),
  J3Rpcs.toLayerHandler("bot.freshStart", notFaked),
  J3Rpcs.toLayerHandler("routine.run", notFaked),
  J3Rpcs.toLayerHandler("usage.turns", notFaked),
).pipe(Layer.provide(fakes));

const server = Server.layer(unserved).pipe(Layer.provideMerge(fakes));

/** A fresh client of the test server, with `stored` as its saved credential. */
const client = (stored: Option.Option<DeviceCredential> = Option.none()) =>
  Layer.unwrap(
    Effect.map(Server.origin, (origin) =>
      ClientRuntime.layer.pipe(Layer.provideMerge(TestPlatform.layer(origin, stored))),
    ),
  );

const isConnected = (state: ConnectionState) => state._tag === "connected";

/** Pairs the client with a code from the server, typed the way a person might. */
const pairAndConnect = Effect.gen(function* () {
  const { code } = yield* (yield* Server.Devices).startPairing;
  const connection = yield* Connection;
  yield* connection.pair({
    code: `${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`,
    deviceName: "Test client",
  });
  yield* waitFor(connection.state, isConnected);
});

/** A bot, created through the client's typed RPC client. */
const createBot = (name: string) =>
  Effect.gen(function* () {
    const connection = yield* Connection;
    const commandId = yield* (yield* Actions).commandId;
    const bot = yield* connection.call((rpc) => rpc["bot.create"]({ commandId, name }));
    return bot.id;
  });

const botSays = (botId: BotId, text: string) =>
  Effect.gen(function* () {
    const entries = yield* Server.Entries;
    return yield* entries.append({
      target: { _tag: "conversation", botId },
      entry: {
        _tag: "message",
        author: { _tag: "bot", botId },
        text,
        attachments: [],
        mentions: { _tag: "bots", ids: [] },
        delivery: { _tag: "delivered" },
        commandId: null,
      },
    });
  });

const entryIds = (state: ConversationState) =>
  state.items.flatMap((item) => (item._tag === "outgoing" ? [] : [item.id]));

it.layer(server, { excludeTestServices: true })("client runtime", (it) => {
  it.effect("pairs with a code typed in any case, then connects", () =>
    Effect.gen(function* () {
      const connection = yield* Connection;
      assert.deepStrictEqual(
        (yield* waitFor(connection.state, (state) => state._tag === "unpaired"))._tag,
        "unpaired",
      );

      yield* pairAndConnect;

      const stored = yield* (yield* CredentialStore).load;
      assert.isTrue(Option.isSome(stored));
      const devices = yield* waitFor((yield* Devices).state, (state) => state._tag === "ready");
      const current =
        devices._tag === "ready" ? devices.value.find((device) => device.current) : null;
      assert.strictEqual(current?.name, "Test client");
    }).pipe(Effect.provide(client())),
  );

  it.effect("asks to pair again when the ticket route refuses the saved credential", () =>
    Effect.gen(function* () {
      const connection = yield* Connection;
      const refused = yield* waitFor(connection.state, (state) => state._tag === "unpaired");
      assert.deepStrictEqual(refused, { _tag: "unpaired", revoked: true });
      assert.isTrue(Option.isNone(yield* (yield* CredentialStore).load));

      yield* pairAndConnect;
    }).pipe(
      Effect.provide(
        client(
          Option.some({
            deviceId: DeviceId.make("never-paired"),
            token: Redacted.make(DeviceToken.make("a-token-this-server-never-issued-to-anyone")),
          }),
        ),
      ),
    ),
  );

  it.effect("stops and asks to pair again when the device is revoked", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const connection = yield* Connection;
      const stored = yield* (yield* CredentialStore).load;
      if (Option.isNone(stored)) return assert.fail("The pairing was not saved");

      yield* (yield* Server.DeviceAuth).revoke(stored.value.deviceId);

      const revoked = yield* waitFor(connection.state, (state) => state._tag === "unpaired");
      assert.deepStrictEqual(revoked, { _tag: "unpaired", revoked: true });
      assert.isTrue(Option.isNone(yield* (yield* CredentialStore).load));
      const refused = yield* connection.call((rpc) => rpc["settings.get"]()).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "NotPaired");
    }).pipe(Effect.provide(client())),
  );

  it.effect("updates the roster live", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const roster = (yield* Roster).state;
      yield* waitFor(roster, (state) => state._tag === "ready");

      const botId = yield* createBot("Scout");

      const updated = yield* waitFor(
        roster,
        (state) =>
          state._tag === "ready" &&
          state.value.some((item) => item._tag === "bot" && item.bot.id === botId),
      );
      assert.isFalse(updated._tag === "ready" && updated.stale);
    }).pipe(Effect.provide(client())),
  );

  it.effect("resyncs a conversation after a reconnect, never blank and never doubled", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const network = yield* TestPlatform.TestNetwork;
      const connection = yield* Connection;
      const botId = yield* createBot("Echo");
      const target: EntryTarget = { _tag: "conversation", botId };
      const first = yield* botSays(botId, "one");
      if (first._tag !== "message") return assert.fail("A bot message was not stored as one");
      yield* botSays(botId, "two");

      const conversation = yield* (yield* Conversations).open(target);
      const before = yield* waitFor(
        conversation.state,
        (state) => state.phase === "ready" && entryIds(state).length >= 2,
      );
      const seen: Array<ConversationState> = [];
      const unsubscribe = conversation.state.subscribe(() => seen.push(conversation.state.get()));

      yield* network.set("offline");
      yield* network.dropSockets;
      yield* waitFor(connection.state, (state) => state._tag === "offline");
      yield* waitFor(conversation.state, (state) => state.stale);
      // Changed while the client was away: one entry edited, one added.
      const entries = yield* Server.Entries;
      yield* entries.update({ ...first, text: "one, edited" });
      const third = yield* botSays(botId, "three");
      yield* network.set("online");

      const after = yield* waitFor(
        conversation.state,
        (state) => !state.stale && entryIds(state).includes(third.id),
      );
      unsubscribe();
      const ids = entryIds(after);
      assert.deepStrictEqual(ids, [...new Set(ids)]);
      assert.deepStrictEqual(ids, [...entryIds(before), third.id]);
      const edited = after.items.find((item) => item._tag === "message" && item.id === first.id);
      assert.strictEqual(edited?._tag === "message" && edited.text, "one, edited");
      for (const state of seen) assert.isAtLeast(entryIds(state).length, entryIds(before).length);
    }).pipe(Effect.scoped, Effect.provide(client())),
  );

  it.effect("shows a sent message at once and keeps one copy through a dropped socket", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const { gate, sends } = yield* Fakes;
      const network = yield* TestPlatform.TestNetwork;
      const conversations = yield* Conversations;
      const botId = yield* createBot("Courier");
      const target: EntryTarget = { _tag: "conversation", botId };
      const conversation = yield* conversations.open(target);
      yield* waitFor(conversation.state, (state) => state.phase === "ready");

      yield* gate.close;
      const sending = yield* Effect.forkChild(conversations.send({ target, text: "hello" }));
      const optimistic = yield* waitFor(conversation.state, (state) =>
        state.items.some((item) => item._tag === "outgoing"),
      );
      const outgoing = optimistic.items.find((item) => item._tag === "outgoing");
      if (outgoing?._tag !== "outgoing") return assert.fail("No outgoing message");
      assert.deepStrictEqual(messageStatus(outgoing), { _tag: "sending" });

      // The socket drops while the server holds the command; the client sends
      // it again, with the same id, once it is back.
      assert.strictEqual(yield* Queue.take(sends), outgoing.commandId);
      yield* network.dropSockets;
      assert.strictEqual(yield* Queue.take(sends), outgoing.commandId);
      yield* gate.open;
      const result = yield* Fiber.join(sending);

      assert.strictEqual(result._tag, "done");
      const confirmed = yield* waitFor(
        conversation.state,
        (state) => !state.items.some((item) => item._tag === "outgoing"),
      );
      const copies = confirmed.items.filter(
        (item) => item._tag === "message" && item.commandId === outgoing.commandId,
      );
      assert.strictEqual(copies.length, 1);
      const [copy] = copies;
      assert.deepStrictEqual(copy?._tag === "message" && messageStatus(copy), { _tag: "queued" });
    }).pipe(Effect.scoped, Effect.provide(client())),
  );

  it.effect("answers a card once when it is submitted twice", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const { gate, answers } = yield* Fakes;
      const conversations = yield* Conversations;
      const actions = yield* Actions;
      const botId = yield* createBot("Asker");
      const entries = yield* Server.Entries;
      const card = yield* entries.append({
        target: { _tag: "conversation", botId },
        entry: {
          _tag: "question",
          author: { _tag: "bot", botId },
          origin: "ask",
          questions: [
            {
              id: "pick",
              prompt: "Which one?",
              options: [
                { id: "a", label: "A", description: null, style: "default" },
                { id: "b", label: "B", description: null, style: "default" },
              ],
              acceptsText: false,
              multiple: false,
            },
          ],
          status: { _tag: "pending" },
        },
      });
      const conversation = yield* conversations.open({ _tag: "conversation", botId });
      yield* waitFor(conversation.state, (state) => entryIds(state).includes(card.id));

      yield* gate.close;
      const pick = (option: string) =>
        conversations.answerCard(card.id, {
          _tag: "question",
          answers: { pick: { optionIds: [option], text: null } },
        });
      const first = yield* Effect.forkChild(pick("a"));
      yield* waitFor(
        actions.state,
        (state) => state.get(cardAction(card.id))?._tag === "submitting",
      );
      const second = yield* Effect.forkChild(pick("b"));
      yield* gate.open;

      assert.deepStrictEqual(yield* Fiber.join(first), { _tag: "done", value: undefined });
      assert.deepStrictEqual(yield* Fiber.join(second), { _tag: "done", value: undefined });
      yield* Queue.take(answers);
      assert.strictEqual(yield* Queue.size(answers), 0);
      const answered = yield* waitFor(conversation.state, (state) =>
        state.items.some(
          (item) =>
            item._tag === "question" && item.id === card.id && item.status._tag === "answered",
        ),
      );
      const resolved = answered.items.find(
        (item) => item._tag === "question" && item.id === card.id,
      );
      assert.deepStrictEqual(resolved?._tag === "question" && resolved.status, {
        _tag: "answered",
        answers: { pick: { optionIds: ["a"], text: null } },
      });
      // Once the resolved card has arrived, nothing is held for it any more.
      yield* waitFor(actions.state, (state) => !state.has(cardAction(card.id)));
    }).pipe(Effect.scoped, Effect.provide(client())),
  );
});
