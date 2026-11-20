// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotId,
  type CommandId,
  DeviceId,
  DeviceToken,
  type EntryId,
  type EntryTarget,
  HTTP_PATHS,
  J3Rpcs,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_LENGTH,
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
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ClientRuntime from "../src/client.ts";
import { Connection, type ConnectionState } from "../src/connection/Connection.ts";
import { Actions, cardAction } from "../src/intents/Actions.ts";
import { type ClientStorage, CredentialStore, type DeviceCredential } from "../src/ports.ts";
import { waitFor } from "../src/Store.ts";
import {
  type ConversationState,
  Conversations,
  messageStatus,
  targetKey,
} from "../src/stores/Conversations.ts";
import { Devices } from "../src/stores/Devices.ts";
import { Drafts } from "../src/stores/Drafts.ts";
import { Roster } from "../src/stores/Roster.ts";
import { SignOut } from "../src/intents/SignOut.ts";
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
    /** The entry each `message.send` command made, on any socket. */
    readonly applied: Map<CommandId, EntryId>;
  }
>()("@j3-bots/client-runtime/test/client.test/Fakes") {}

const fakes = Layer.effect(
  Fakes,
  Effect.gen(function* () {
    return Fakes.of({
      gate: yield* Latch.make(true),
      sends: yield* Queue.unbounded<CommandId>(),
      answers: yield* Queue.unbounded<CommandId>(),
      applied: new Map(),
    });
  }),
);

const notFaked = () => Effect.die("Not faked");

const unserved = Layer.mergeAll(
  J3Rpcs.toLayerHandler(
    "message.send",
    Effect.gen(function* () {
      const { gate, sends, applied } = yield* Fakes;
      const entries = yield* Server.Entries;
      const files = yield* Server.Attachments;
      const once = Semaphore.makeUnsafe(1);
      return ({ commandId, target, text, attachments, mentions }) =>
        Effect.gen(function* () {
          yield* Queue.offer(sends, commandId);
          yield* gate.await;
          return yield* once.withPermits(1)(
            Effect.gen(function* () {
              const known = applied.get(commandId);
              if (known !== undefined) return known;
              const stored = yield* Effect.forEach(attachments, (id) => files.open(id));
              const entry = yield* entries.append({
                target,
                commandId,
                entry: {
                  _tag: "message",
                  author: { _tag: "operator" },
                  text,
                  attachments: stored.flatMap((file) =>
                    Option.isSome(file) ? [file.value.attachment] : [],
                  ),
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

/**
 * A fresh client of the test server, with `stored` as its saved credential.
 * Two clients on one `device` are one device before and after a reload, or
 * two tabs of one browser. Each builds every service of its own, as a tab does.
 */
const client = (
  stored: Option.Option<DeviceCredential> = Option.none(),
  device = TestPlatform.makeDevice(),
  http?: Layer.Layer<HttpClient.HttpClient>,
) =>
  Layer.unwrap(
    Effect.map(Server.origin, (origin) =>
      Layer.fresh(
        ClientRuntime.layer.pipe(
          Layer.provideMerge(TestPlatform.layer(origin, stored, device, http)),
        ),
      ),
    ),
  );

/**
 * A reverse proxy in front of the server whose own login has expired: it
 * answers the ticket route with its sign-in page, as a 401.
 */
const proxyLoginExpired = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const server = yield* HttpClient.HttpClient;
    return HttpClient.make((request, url) =>
      url.pathname === HTTP_PATHS.socketTicket
        ? Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("<html>Sign in to continue</html>", {
                status: 401,
                headers: { "content-type": "text/html" },
              }),
            ),
          )
        : server.execute(request),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Something between the client and the server that takes the first `times`
 * requests to `path` and never answers them, and passes the rest on.
 */
const neverAnswers = (path: string, times = Number.POSITIVE_INFINITY) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const server = yield* HttpClient.HttpClient;
      let held = 0;
      return HttpClient.make((request, url) => {
        if (url.pathname !== path || held >= times) return server.execute(request);
        held += 1;
        return Effect.never;
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * A reverse proxy in front of uploads whose own login has expired: it answers
 * the first with its sign-in page, as a 401, sends the second to that page,
 * which answers it from another address, and passes the rest on.
 */
const uploadsBehindProxyLogin = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const server = yield* HttpClient.HttpClient;
    let seen = 0;
    return HttpClient.make((request, url) => {
      if (url.pathname !== HTTP_PATHS.attachments) return server.execute(request);
      seen += 1;
      if (seen === 1) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("<html>Sign in to continue</html>", {
              status: 401,
              headers: { "content-type": "text/html" },
            }),
          ),
        );
      }
      if (seen === 2) {
        return server.execute(HttpClientRequest.get(new URL(HTTP_PATHS.server, url).toString()));
      }
      return server.execute(request);
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * A server whose attachments folder was linked out of its private data: it
 * answers every upload with `Conflict("private-location")`. Counts the
 * uploads it refused.
 */
const uploadsInPrivateLocation = (refused: { count: number }) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const server = yield* HttpClient.HttpClient;
      return HttpClient.make((request, url) => {
        if (url.pathname !== HTTP_PATHS.attachments) return server.execute(request);
        refused.count += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ _tag: "Conflict", reason: "private-location" }, { status: 409 }),
          ),
        );
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/** The credential the client saved, for the same device's next launch. */
const savedCredential = Effect.gen(function* () {
  return yield* (yield* CredentialStore).load;
});

/** Polls the device's storage until `table`'s record for `key` passes `check`. */
const whenStored = (
  storage: ClientStorage["Service"],
  table: "drafts" | "outbox",
  key: string,
  check: (record: string | undefined) => boolean,
) =>
  storage.readAll(table).pipe(
    Effect.orDie,
    Effect.repeat({
      until: (records) => check(records.get(key)),
      schedule: Schedule.spaced("5 millis"),
    }),
  );

const present = (record: string | undefined) => record !== undefined;
const absent = (record: string | undefined) => record === undefined;
const holds = (text: string) => (record: string | undefined) => record?.includes(text) === true;

const decodeDraftRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ text: Schema.String, files: Schema.Array(Schema.Unknown) }),
  ),
);
/** Whether a draft record holds no draft: there is none, or it was emptied or sent. */
const noDraft = (record: string | undefined) =>
  record === undefined ||
  Option.exists(
    decodeDraftRecord(record),
    (draft) => draft.text === "" && draft.files.length === 0,
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
      assert.deepStrictEqual(refused, { _tag: "unpaired", reason: "signed-out" });
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
      assert.deepStrictEqual(revoked, { _tag: "unpaired", reason: "signed-out" });
      assert.isTrue(Option.isNone(yield* (yield* CredentialStore).load));
      const refused = yield* connection.call((rpc) => rpc["settings.get"]()).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "NotPaired");
    }).pipe(Effect.provide(client())),
  );

  it.effect("keeps the device when a proxy before the server refuses it with its own login", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Guarded") };
        yield* (yield* Drafts).setText(target, "keep me");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        return { target, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));

      yield* Effect.gen(function* () {
        const connection = yield* Connection;
        const refused = yield* waitFor(
          connection.state,
          (state) => state._tag === "waiting" || state._tag === "unpaired",
        );
        assert.deepStrictEqual(refused._tag === "waiting" && refused.reason, "unreachable");
        assert.isTrue(Option.isSome(yield* (yield* CredentialStore).load));
        const draft = (yield* Drafts).state.get().get(targetKey(first.target));
        assert.strictEqual(draft?.text, "keep me");
        yield* whenStored(device.storage, "drafts", targetKey(first.target), present);
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device, proxyLoginExpired)));
    }),
  );

  it.effect("signs out: the server revokes the device and nothing of it stays here", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Fakes;
      const device = TestPlatform.makeDevice();
      yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const connection = yield* Connection;
        const deviceId = yield* connection.deviceId;
        const botId = yield* createBot("Left behind");
        const target: EntryTarget = { _tag: "conversation", botId };
        const drafts = yield* Drafts;
        yield* drafts.setText(target, "half a thought");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        yield* gate.close;
        yield* (yield* Conversations).enqueue({ target, text: "on its way" });
        yield* Queue.take(sends);

        assert.strictEqual(yield* (yield* SignOut).run, "signed-out");

        const unpaired = yield* waitFor(connection.state, (state) => state._tag === "unpaired");
        assert.deepStrictEqual(unpaired, { _tag: "unpaired", reason: "signed-out" });
        assert.isTrue(Option.isNone(yield* (yield* CredentialStore).load));
        assert.strictEqual((yield* device.storage.readAll("drafts").pipe(Effect.orDie)).size, 0);
        assert.strictEqual((yield* device.storage.readAll("outbox").pipe(Effect.orDie)).size, 0);
        assert.strictEqual(drafts.state.get().size, 0);
        const listed = yield* (yield* Server.Devices).list(deviceId);
        assert.isFalse(listed.some((device) => device.id === deviceId));
      }).pipe(Effect.ensuring(gate.open), Effect.provide(client(Option.none(), device)));
    }),
  );

  it.effect("revokes the device and deletes its credential when its drafts cannot be deleted", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const deviceId = yield* (yield* Connection).deviceId;
      yield* (yield* Drafts).setText(
        { _tag: "conversation", botId: yield* createBot("Stubborn") },
        "stuck here",
      );

      assert.strictEqual(yield* (yield* SignOut).run, "signed-out");

      assert.isTrue(Option.isNone(yield* (yield* CredentialStore).load));
      const listed = yield* (yield* Server.Devices).list(deviceId);
      assert.isFalse(listed.some((device) => device.id === deviceId));
    }).pipe(Effect.provide(client(Option.none(), TestPlatform.makeDevice({ refuseClears: true })))),
  );

  it.effect("signs out without the server, which still lists the device", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const connection = yield* Connection;
      const deviceId = yield* connection.deviceId;
      const network = yield* TestPlatform.TestNetwork;
      yield* network.set("offline");
      yield* waitFor(connection.state, (state) => state._tag === "offline");
      // Long enough for the client to settle into waiting for the network.
      yield* Effect.sleep("50 millis");

      assert.strictEqual(yield* (yield* SignOut).run, "still-listed");

      const unpaired = yield* waitFor(connection.state, (state) => state._tag === "unpaired");
      assert.deepStrictEqual(unpaired, { _tag: "unpaired", reason: "still-listed" });
      assert.isTrue(Option.isNone(yield* (yield* CredentialStore).load));
      const listed = yield* (yield* Server.Devices).list(deviceId);
      assert.isTrue(listed.some((device) => device.id === deviceId));
    }).pipe(Effect.provide(client())),
  );

  it.effect("counts a socket ticket that never comes as the server out of reach", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const credential = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        return yield* savedCredential;
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));

      yield* Effect.gen(function* () {
        const waiting = yield* waitFor(
          (yield* Connection).state,
          (state) => state._tag === "waiting",
        );
        assert.strictEqual(waiting._tag === "waiting" && waiting.reason, "unreachable");
      }).pipe(
        Effect.scoped,
        Effect.provide(client(credential, device, neverAnswers(HTTP_PATHS.socketTicket))),
      );
    }),
  );

  it.effect("uploads a file again when the first attempt never answers", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const drafts = yield* Drafts;
      const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Persistent") };
      yield* drafts.attach(target, [
        { name: "slow.txt", body: new Blob(["eventually"], { type: "text/plain" }) },
      ]);

      yield* waitFor(drafts.state, (state) =>
        (state.get(targetKey(target))?.files ?? []).some((file) => file._tag === "ready"),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        client(Option.none(), TestPlatform.makeDevice(), neverAnswers(HTTP_PATHS.attachments, 1)),
      ),
    ),
  );

  it.effect("keeps uploading a file through a proxy's login page, and keeps the device", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const drafts = yield* Drafts;
      const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Proxied") };
      yield* drafts.attach(target, [
        { name: "notes.txt", body: new Blob(["notes"], { type: "text/plain" }) },
      ]);

      const settled = yield* waitFor(drafts.state, (state) =>
        (state.get(targetKey(target))?.files ?? []).some((file) => file._tag !== "uploading"),
      );
      assert.deepStrictEqual(
        settled.get(targetKey(target))?.files.map((file) => file._tag),
        ["ready"],
      );
      assert.isTrue(Option.isSome(yield* (yield* CredentialStore).load));
    }).pipe(
      Effect.scoped,
      Effect.provide(client(Option.none(), TestPlatform.makeDevice(), uploadsBehindProxyLogin)),
    ),
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

  it.effect("goes offline when the platform loses the network, though the socket still works", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const network = yield* TestPlatform.TestNetwork;
      const connection = yield* Connection;
      yield* network.set("offline");
      yield* waitFor(connection.state, (state) => state._tag === "offline");
      yield* network.set("online");
      yield* waitFor(connection.state, (state) => state._tag === "connected");
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

  it.effect("sends a message an earlier launch left unsent, once", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Fakes;
      const device = TestPlatform.makeDevice();

      // The first launch sends while the server holds the command, then ends.
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const botId = yield* createBot("Patient");
        yield* gate.close;
        yield* (yield* Conversations).enqueue({
          target: { _tag: "conversation", botId },
          text: "still there?",
        });
        const commandId = yield* Queue.take(sends);
        return { botId, commandId, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      yield* whenStored(device.storage, "outbox", first.commandId, present);

      // The next launch on the same device sends it with the same command id.
      yield* Effect.gen(function* () {
        const conversations = yield* Conversations;
        const conversation = yield* conversations.open({
          _tag: "conversation",
          botId: first.botId,
        });
        assert.strictEqual(yield* Queue.take(sends), first.commandId);
        yield* gate.open;
        const delivered = yield* waitFor(
          conversation.state,
          (state) =>
            state.phase === "ready" &&
            !state.items.some((item) => item._tag === "outgoing") &&
            state.items.some(
              (item) => item._tag === "message" && item.commandId === first.commandId,
            ),
        );
        const copies = delivered.items.filter(
          (item) => item._tag === "message" && item.commandId === first.commandId,
        );
        assert.strictEqual(copies.length, 1);
        yield* whenStored(device.storage, "outbox", first.commandId, absent);
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("sends two messages queued offline in the order they were written", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const { gate, sends } = yield* Fakes;
      const network = yield* TestPlatform.TestNetwork;
      const connection = yield* Connection;
      const drafts = yield* Drafts;
      const botId = yield* createBot("Orderly");
      const target: EntryTarget = { _tag: "conversation", botId };
      const conversation = yield* (yield* Conversations).open(target);
      yield* waitFor(conversation.state, (state) => state.phase === "ready");

      yield* network.set("offline");
      yield* waitFor(connection.state, (state) => state._tag === "offline");
      for (const text of ["first", "second"]) {
        yield* drafts.setText(target, text);
        assert.strictEqual(yield* drafts.send(target), "sent");
      }
      const queued = conversation.state
        .get()
        .items.flatMap((item) => (item._tag === "outgoing" ? [item.commandId] : []));
      assert.strictEqual(queued.length, 2);

      yield* gate.close;
      yield* network.set("online");
      assert.strictEqual(yield* Queue.take(sends), queued[0]);
      // The second waits until the server has answered the first.
      const early = yield* Queue.take(sends).pipe(Effect.timeoutOption("100 millis"));
      assert.isTrue(Option.isNone(early));
      yield* gate.open;
      assert.strictEqual(yield* Queue.take(sends), queued[1]);

      const delivered = yield* waitFor(
        conversation.state,
        (state) => !state.items.some((item) => item._tag === "outgoing"),
      );
      assert.deepStrictEqual(
        delivered.items.flatMap((item) => (item._tag === "message" ? [item.commandId] : [])),
        queued,
      );
    }).pipe(Effect.scoped, Effect.provide(client())),
  );

  it.effect("takes no edits while the draft moves to the outbox, then clears it", () =>
    Effect.gen(function* () {
      const commitGate = yield* Latch.make(true);
      const device = TestPlatform.makeDevice({ commitGate });
      yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const drafts = yield* Drafts;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Steady") };
        const key = targetKey(target);
        yield* drafts.setText(target, "as written");
        yield* whenStored(device.storage, "drafts", key, present);
        yield* commitGate.close;

        const sending = yield* Effect.forkChild(drafts.send(target));
        yield* waitFor(drafts.state, (state) => state.get(key)?.sending === true);
        yield* drafts.setText(target, "typed after Send");
        yield* drafts.attach(target, [
          { name: "late.txt", body: new Blob(["late"], { type: "text/plain" }) },
        ]);
        assert.deepStrictEqual(drafts.state.get().get(key), {
          text: "as written",
          files: [],
          sending: true,
        });

        yield* commitGate.open;
        assert.strictEqual(yield* Fiber.join(sending), "sent");
        assert.isUndefined(drafts.state.get().get(key));
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
    }),
  );

  it.effect("sends a draft two tabs hold once, and the other tab shows what is left", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Fakes;
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Twins") };
        yield* (yield* Drafts).setText(target, "only once");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        return { target, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const key = targetKey(first.target);

      yield* gate.close;
      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          // Both tabs read the same draft; each sends it from what it read.
          const results = yield* Effect.all([one.send(first.target), two.send(first.target)], {
            concurrency: "unbounded",
          });

          assert.deepStrictEqual(results.toSorted(), ["changed-elsewhere", "sent"]);
          const outbox = yield* device.storage.readAll("outbox").pipe(Effect.orDie);
          assert.strictEqual(outbox.size, 1);
          assert.isUndefined(one.state.get().get(key));
          assert.isUndefined(two.state.get().get(key));
          yield* Queue.take(sends);
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(gate.open),
        Effect.provide(client(first.credential, device)),
      );
    }),
  );

  it.effect(
    "shows a draft another tab sent instead of writing it back, and restores on request",
    () =>
      Effect.gen(function* () {
        const { gate, sends } = yield* Fakes;
        const device = TestPlatform.makeDevice();
        const first = yield* Effect.gen(function* () {
          yield* pairAndConnect;
          const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Echoes") };
          yield* (yield* Drafts).setText(target, "as read");
          yield* whenStored(device.storage, "drafts", targetKey(target), present);
          return { target, credential: yield* savedCredential };
        }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
        const key = targetKey(first.target);
        const outbox = device.storage.readAll("outbox").pipe(Effect.orDie);

        yield* gate.close;
        yield* Effect.gen(function* () {
          const one = yield* Drafts;
          yield* Effect.gen(function* () {
            const two = yield* Drafts;
            const noticed = yield* Stream.runHead(two.changedElsewhere).pipe(
              Effect.forkChild({ startImmediately: true }),
            );
            assert.strictEqual(yield* one.send(first.target), "sent");
            yield* Queue.take(sends);

            // The second tab still shows the draft as it read it, and goes on writing.
            yield* two.setText(first.target, "as read, and more");

            assert.deepStrictEqual(
              yield* Fiber.join(noticed),
              Option.some({ target: first.target, whileSending: false, restorable: true }),
            );
            assert.isUndefined(two.state.get().get(key));
            yield* whenStored(device.storage, "drafts", key, noDraft);
            assert.strictEqual((yield* outbox).size, 1);

            yield* two.restore(first.target);
            assert.strictEqual(two.state.get().get(key)?.text, "as read, and more");
            yield* whenStored(
              device.storage,
              "drafts",
              key,
              (record) => record?.includes("as read, and more") === true,
            );
            assert.strictEqual((yield* outbox).size, 1);
          }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
        }).pipe(
          Effect.scoped,
          Effect.ensuring(gate.open),
          Effect.provide(client(first.credential, device)),
        );
      }),
  );

  it.effect("loses neither tab's text when two tabs change the same draft", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Shared") };
        yield* (yield* Drafts).setText(target, "shared");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        return { target, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const key = targetKey(first.target);

      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          yield* one.setText(first.target, "shared, from one");
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
          const noticed = yield* Stream.runHead(two.changedElsewhere).pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          yield* two.setText(first.target, "shared, from two");

          assert.deepStrictEqual(
            yield* Fiber.join(noticed),
            Option.some({ target: first.target, whileSending: false, restorable: true }),
          );
          assert.strictEqual(two.state.get().get(key)?.text, "shared, from one");
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
          yield* two.restore(first.target);
          yield* whenStored(device.storage, "drafts", key, holds("from two"));
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("sends nothing when another tab's change replaces the draft while Send waits", () =>
    Effect.gen(function* () {
      const commitGate = yield* Latch.make(true);
      const committing = yield* Queue.unbounded<void>();
      const device = TestPlatform.makeDevice({ commitGate, committing });
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Rivals") };
        yield* (yield* Drafts).setText(target, "shared");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        return { target, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const key = targetKey(first.target);

      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          yield* one.setText(first.target, "shared, from one");
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
          const noticed = yield* Stream.runHead(two.changedElsewhere).pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          // The second tab's autosave holds the draft, waiting on the device, as Send is pressed.
          yield* commitGate.close;
          yield* Queue.clear(committing);
          yield* two.setText(first.target, "shared, from two");
          yield* Queue.take(committing);
          const sending = yield* two
            .send(first.target)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* commitGate.open;

          assert.strictEqual(yield* Fiber.join(sending), "changed-elsewhere");
          assert.deepStrictEqual(
            yield* Fiber.join(noticed),
            Option.some({ target: first.target, whileSending: true, restorable: true }),
          );
          assert.strictEqual(two.state.get().get(key)?.text, "shared, from one");
          assert.strictEqual((yield* device.storage.readAll("outbox").pipe(Effect.orDie)).size, 0);
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("never writes back a draft Send moved while its autosave waited", () =>
    Effect.gen(function* () {
      const commitGate = yield* Latch.make(true);
      const device = TestPlatform.makeDevice({ commitGate });
      yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const drafts = yield* Drafts;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Hasty") };
        const later: EntryTarget = { _tag: "conversation", botId: yield* createBot("Later") };

        yield* commitGate.close;
        yield* drafts.setText(target, "typed and sent at once");
        const sending = yield* drafts
          .send(target)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* commitGate.open;
        assert.strictEqual(yield* Fiber.join(sending), "sent");
        yield* Queue.take((yield* Fakes).sends);

        // Drafts are kept one after another: once a later one is, the sent one had its turn.
        yield* drafts.setText(later, "afterwards");
        yield* whenStored(device.storage, "drafts", targetKey(later), present);
        const stored = yield* device.storage.readAll("drafts").pipe(Effect.orDie);
        assert.isTrue(noDraft(stored.get(targetKey(target))));
        assert.isUndefined(drafts.state.get().get(targetKey(target)));
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
    }),
  );

  it.effect("keeps a file still uploading when another tab changes the draft", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Uploader") };
        yield* (yield* Drafts).setText(target, "shared");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        return { target, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const key = targetKey(first.target);

      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          yield* one.setText(first.target, "shared, from one");
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
          const noticed = yield* Stream.runHead(two.changedElsewhere).pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          yield* two.attach(first.target, [
            { name: "slow.txt", body: new Blob(["slow"], { type: "text/plain" }) },
          ]);
          yield* two.setText(first.target, "shared, from two");

          const notice = yield* Fiber.join(noticed);
          const shown = two.state.get().get(key);
          assert.strictEqual(shown?.text, "shared, from one");
          assert.deepStrictEqual(
            shown?.files.map((file) => [file._tag, file._tag === "ready" ? null : file.name]),
            [["uploading", "slow.txt"]],
          );
          assert.deepStrictEqual(
            notice,
            Option.some({ target: first.target, whileSending: false, restorable: true }),
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(client(first.credential, device, neverAnswers(HTTP_PATHS.attachments))),
        );
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("keeps a file this tab uploaded when another tab changed the draft first", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Keeper") };
        yield* (yield* Drafts).setText(target, "shared");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        return { target, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const key = targetKey(first.target);

      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          yield* one.setText(first.target, "shared, from one");
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
          const noticed = yield* Stream.runHead(two.changedElsewhere).pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          // Its upload ends, and its write finds the draft changed.
          yield* two.attach(first.target, [
            { name: "notes.txt", body: new Blob(["notes"], { type: "text/plain" }) },
          ]);
          yield* Fiber.join(noticed);

          const shown = two.state.get().get(key);
          assert.strictEqual(shown?.text, "shared, from one");
          assert.deepStrictEqual(
            shown?.files.map((file) => (file._tag === "ready" ? file.attachment.name : file._tag)),
            ["notes.txt"],
          );
          yield* whenStored(
            device.storage,
            "drafts",
            key,
            (record) => holds("from one")(record) && holds("notes.txt")(record),
          );
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("offers no restore when this tab held only what the device kept", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Settled") };
        yield* (yield* Drafts).setText(target, "shared");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        return { target, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const key = targetKey(first.target);

      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          yield* one.setText(first.target, "shared, from one");
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
          const noticed = yield* Stream.runHead(two.changedElsewhere).pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          assert.strictEqual(yield* two.send(first.target), "changed-elsewhere");
          const notice = yield* Fiber.join(noticed);

          // Restoring would put back what the other tab replaced.
          yield* two.restore(first.target);
          assert.strictEqual(two.state.get().get(key)?.text, "shared, from one");
          assert.deepStrictEqual(
            notice,
            Option.some({ target: first.target, whileSending: true, restorable: false }),
          );
          assert.strictEqual((yield* device.storage.readAll("outbox").pipe(Effect.orDie)).size, 0);
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect(
    "keeps a draft longer than a message can hold through a reload, and does not send it",
    () =>
      Effect.gen(function* () {
        const device = TestPlatform.makeDevice();
        const long = "x".repeat(MAX_MESSAGE_LENGTH + 1);
        const first = yield* Effect.gen(function* () {
          yield* pairAndConnect;
          const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Verbose") };
          yield* (yield* Drafts).setText(target, long);
          yield* whenStored(device.storage, "drafts", targetKey(target), present);
          return { target, credential: yield* savedCredential };
        }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));

        yield* Effect.gen(function* () {
          const drafts = yield* Drafts;
          assert.strictEqual(drafts.state.get().get(targetKey(first.target))?.text, long);
          assert.strictEqual(yield* drafts.send(first.target), "too-long");
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }),
  );

  it.effect("sends one conversation's messages from two tabs one at a time, in order", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Fakes;
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        return { botId: yield* createBot("Relay"), credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const target: EntryTarget = { _tag: "conversation", botId: first.botId };

      yield* gate.close;
      yield* Effect.gen(function* () {
        const one = yield* Conversations;
        const conversation = yield* one.open(target);
        yield* one.enqueue({ target, text: "first" });
        const firstId = yield* Queue.take(sends);

        yield* Effect.gen(function* () {
          yield* (yield* Conversations).enqueue({ target, text: "second" });
          // The first tab holds the conversation until the server answers its message.
          const early = yield* Queue.take(sends).pipe(Effect.timeoutOption("100 millis"));
          assert.isTrue(Option.isNone(early));
          yield* gate.open;
          const secondId = yield* Queue.take(sends);
          assert.notStrictEqual(secondId, firstId);

          const delivered = yield* waitFor(
            conversation.state,
            (state) =>
              state.items.filter((item) => item._tag === "message").length === 2 &&
              !state.items.some((item) => item._tag === "outgoing"),
          );
          assert.deepStrictEqual(
            delivered.items.flatMap((item) => (item._tag === "message" ? [item.commandId] : [])),
            [firstId, secondId],
          );
          // Each went once: the second tab finds nothing left to send.
          const again = yield* Queue.take(sends).pipe(Effect.timeoutOption("100 millis"));
          assert.isTrue(Option.isNone(again));
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(gate.open),
        Effect.provide(client(first.credential, device)),
      );
    }),
  );

  it.effect("sends a message another tab kept offline once that tab has closed", () =>
    Effect.gen(function* () {
      const { sends } = yield* Fakes;
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        return { botId: yield* createBot("Handover"), credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const target: EntryTarget = { _tag: "conversation", botId: first.botId };
      const goOffline = Effect.gen(function* () {
        yield* (yield* TestPlatform.TestNetwork).set("offline");
        yield* waitFor((yield* Connection).state, (state) => state._tag === "offline");
      });

      yield* Effect.gen(function* () {
        yield* goOffline;
        // Another tab, offline too, keeps a message and closes before it can send it.
        const commandId = yield* Effect.gen(function* () {
          yield* goOffline;
          const drafts = yield* Drafts;
          yield* drafts.setText(target, "left behind");
          assert.strictEqual(yield* drafts.send(target), "sent");
          const [kept] = (yield* device.storage.readAll("outbox").pipe(Effect.orDie)).keys();
          return kept;
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
        if (commandId === undefined) return assert.fail("No message kept");

        yield* (yield* TestPlatform.TestNetwork).set("online");
        assert.strictEqual(yield* Queue.take(sends), commandId);
        yield* whenStored(device.storage, "outbox", commandId, absent);
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("refuses a file still uploading that no longer fits the draft another tab kept", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        return { botId: yield* createBot("Crowded"), credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const target: EntryTarget = { _tag: "conversation", botId: first.botId };
      const key = targetKey(target);

      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          yield* two.attach(target, [
            { name: "late.txt", body: new Blob(["late"], { type: "text/plain" }) },
          ]);

          // The first tab keeps a draft of as many files as a message can carry.
          yield* one.attach(
            target,
            Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) => ({
              name: `file-${index}.txt`,
              body: new Blob([`file ${index}`], { type: "text/plain" }),
            })),
          );
          const uploaded = yield* waitFor(
            one.state,
            (state) =>
              (state.get(key)?.files ?? []).filter((file) => file._tag === "ready").length ===
              MAX_ATTACHMENTS_PER_MESSAGE,
          );
          const ids = (uploaded.get(key)?.files ?? []).flatMap((file) =>
            file._tag === "ready" ? [file.attachment.id] : [],
          );
          yield* whenStored(device.storage, "drafts", key, (record) =>
            ids.every((id) => record?.includes(id) === true),
          );
          const noticed = yield* Stream.runHead(two.changedElsewhere).pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          yield* two.setText(target, "from two");
          yield* Fiber.join(noticed);

          assert.deepStrictEqual(
            two.state
              .get()
              .get(key)
              ?.files.map((file) => [file._tag, file._tag === "failed" ? file.problem : null]),
            [...ids.map(() => ["ready", null]), ["failed", "too-many"]],
          );
          assert.strictEqual(yield* two.send(target), "not-ready");
          assert.strictEqual((yield* device.storage.readAll("outbox").pipe(Effect.orDie)).size, 0);
        }).pipe(
          Effect.scoped,
          Effect.provide(client(first.credential, device, neverAnswers(HTTP_PATHS.attachments))),
        );
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("keeps, and does not send, a draft with more files than a message can carry", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        return { botId: yield* createBot("Overloaded"), credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const target: EntryTarget = { _tag: "conversation", botId: first.botId };
      const key = targetKey(target);
      // As an earlier version, which allowed more files, kept it.
      const files = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, index) => ({
        id: `kept-${index}`,
        name: `file-${index}.txt`,
        mediaType: "text/plain",
        size: 1,
      }));
      yield* device.storage
        .write("drafts", key, JSON.stringify({ revision: "earlier", text: "all of them", files }))
        .pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        const drafts = yield* Drafts;
        const kept = drafts.state.get().get(key);
        assert.strictEqual(kept?.files.length, MAX_ATTACHMENTS_PER_MESSAGE + 1);
        assert.strictEqual(yield* drafts.send(target), "too-many-files");
        assert.deepStrictEqual(drafts.state.get().get(key), kept);
        assert.strictEqual((yield* device.storage.readAll("outbox").pipe(Effect.orDie)).size, 0);
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("finds the draft changed when another tab sent one this tab never saw", () =>
    Effect.gen(function* () {
      const { sends } = yield* Fakes;
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        return { botId: yield* createBot("Blank"), credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const target: EntryTarget = { _tag: "conversation", botId: first.botId };
      const key = targetKey(target);

      yield* Effect.gen(function* () {
        // This tab reads no draft.
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          yield* two.setText(target, "from two");
          yield* whenStored(device.storage, "drafts", key, holds("from two"));
          assert.strictEqual(yield* two.send(target), "sent");
          yield* whenStored(device.storage, "outbox", yield* Queue.take(sends), absent);
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
        const noticed = yield* Stream.runHead(one.changedElsewhere).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* one.setText(target, "from one");

        assert.deepStrictEqual(
          yield* Fiber.join(noticed),
          Option.some({ target, whileSending: false, restorable: true }),
        );
        assert.isUndefined(one.state.get().get(key));
        assert.isTrue(
          noDraft((yield* device.storage.readAll("drafts").pipe(Effect.orDie)).get(key)),
        );
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("keeps the draft when the device cannot keep the message", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const { sends } = yield* Fakes;
      const drafts = yield* Drafts;
      const botId = yield* createBot("Careful");
      const target: EntryTarget = { _tag: "conversation", botId };
      const conversation = yield* (yield* Conversations).open(target);
      yield* waitFor(conversation.state, (state) => state.phase === "ready");

      yield* drafts.setText(target, "do not lose me");
      assert.strictEqual(yield* drafts.send(target), "not-kept");

      assert.deepStrictEqual(drafts.state.get().get(targetKey(target)), {
        text: "do not lose me",
        files: [],
        sending: false,
      });
      assert.isFalse(conversation.state.get().items.some((item) => item._tag === "outgoing"));
      assert.strictEqual(yield* Queue.size(sends), 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(client(Option.none(), TestPlatform.makeDevice({ refuseCommits: true }))),
    ),
  );

  it.effect("drops a message sent again once accepted, and shows its entry in the history", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Fakes;
      const device = TestPlatform.makeDevice();

      // The server accepts the message, and the device loses its answer: the
      // record is still on the device, as after a crash.
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const botId = yield* createBot("Chatty");
        yield* gate.close;
        yield* (yield* Conversations).enqueue({
          target: { _tag: "conversation", botId },
          text: "long ago",
        });
        const commandId = yield* Queue.take(sends);
        const records = yield* device.storage.readAll("outbox").pipe(Effect.orDie);
        const record = records.get(commandId);
        if (record === undefined) return assert.fail("The message was not kept");
        yield* gate.open;
        yield* whenStored(device.storage, "outbox", commandId, absent);
        return { botId, commandId, record, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      yield* device.storage.write("outbox", first.commandId, first.record).pipe(Effect.orDie);
      // More than one snapshot's worth of entries comes after it.
      for (let index = 0; index < 101; index++) yield* botSays(first.botId, `reply ${index}`);

      yield* Effect.gen(function* () {
        const conversation = yield* (yield* Conversations).open({
          _tag: "conversation",
          botId: first.botId,
        });
        assert.strictEqual(yield* Queue.take(sends), first.commandId);
        yield* whenStored(device.storage, "outbox", first.commandId, absent);
        const settled = yield* waitFor(
          conversation.state,
          (state) =>
            state.phase === "ready" && !state.items.some((item) => item._tag === "outgoing"),
        );
        const isIt = (item: ConversationState["items"][number]) =>
          item._tag === "message" && item.commandId === first.commandId;
        assert.isFalse(settled.items.some(isIt));

        // Reading back finds it where it belongs: before every reply.
        const read = yield* conversation.loadOlder.pipe(
          Effect.andThen(Effect.sync(() => conversation.state.get())),
          Effect.repeat({ until: (state) => state.items.some(isIt) || !state.hasOlder }),
        );
        const at = read.items.findIndex(isIt);
        assert.isAtLeast(at, 0);
        assert.isBelow(
          at,
          read.items.findIndex((item) => item._tag === "message" && item.author._tag === "bot"),
        );
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("keeps a draft and its uploaded file through a reload, and sends it once", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Fakes;
      const device = TestPlatform.makeDevice();

      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const botId = yield* createBot("Reader");
        const target: EntryTarget = { _tag: "conversation", botId };
        const drafts = yield* Drafts;
        yield* drafts.setText(target, "notes attached");
        yield* drafts.attach(target, [
          { name: "notes.txt", body: new Blob(["first line"], { type: "text/plain" }) },
        ]);
        const ready = yield* waitFor(drafts.state, (state) =>
          (state.get(targetKey(target))?.files ?? []).some((file) => file._tag === "ready"),
        );
        const [file] = ready.get(targetKey(target))?.files ?? [];
        if (file?._tag !== "ready") return assert.fail("No uploaded file");
        assert.strictEqual(file.attachment.name, "notes.txt");
        assert.strictEqual(file.attachment.size, "first line".length);
        // Kept once the writer has the uploaded file too, not only the text.
        yield* whenStored(
          device.storage,
          "drafts",
          targetKey(target),
          (record) => record?.includes(file.attachment.id) === true,
        );
        return { target, attachmentId: file.attachment.id, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));

      yield* Effect.gen(function* () {
        const drafts = yield* Drafts;
        const restored = drafts.state.get().get(targetKey(first.target));
        assert.strictEqual(restored?.text, "notes attached");
        assert.deepStrictEqual(
          restored?.files.map((file) => file._tag === "ready" && file.attachment.id),
          [first.attachmentId],
        );

        // Sending twice, as a double tap would, sends once.
        yield* gate.close;
        const results = yield* Effect.all([drafts.send(first.target), drafts.send(first.target)], {
          concurrency: "unbounded",
        });
        assert.deepStrictEqual(results.toSorted(), ["empty", "sent"]);
        assert.isUndefined(drafts.state.get().get(targetKey(first.target)));
        const commandId = yield* Queue.take(sends);
        yield* gate.open;

        const conversation = yield* (yield* Conversations).open(first.target);
        const delivered = yield* waitFor(conversation.state, (state) =>
          state.items.some((item) => item._tag === "message" && item.commandId === commandId),
        );
        const message = delivered.items.find(
          (item) => item._tag === "message" && item.commandId === commandId,
        );
        assert.deepStrictEqual(
          message?._tag === "message" && message.attachments.map((attachment) => attachment.id),
          [first.attachmentId],
        );
        assert.strictEqual(yield* Queue.size(sends), 0);
        yield* whenStored(device.storage, "drafts", targetKey(first.target), noDraft);
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("marks a file refused, once, when the server cannot store it privately", () => {
    const refused = { count: 0 };
    return Effect.gen(function* () {
      yield* pairAndConnect;
      const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Careful") };
      const drafts = yield* Drafts;
      yield* drafts.attach(target, [
        { name: "notes.txt", body: new Blob(["notes"], { type: "text/plain" }) },
      ]);
      const settled = yield* waitFor(drafts.state, (state) =>
        (state.get(targetKey(target))?.files ?? []).some((file) => file._tag !== "uploading"),
      );
      assert.deepStrictEqual(
        settled
          .get(targetKey(target))
          ?.files.map((file) => [file._tag, file._tag === "failed" ? file.problem : null]),
        [["failed", "server-setup"]],
      );
      assert.strictEqual(refused.count, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        client(Option.none(), TestPlatform.makeDevice(), uploadsInPrivateLocation(refused)),
      ),
    );
  });

  it.effect("refuses a file over the limits without uploading it, and holds the draft", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const botId = yield* createBot("Picky");
      const target: EntryTarget = { _tag: "conversation", botId };
      const drafts = yield* Drafts;
      yield* drafts.attach(target, [
        { name: "empty.txt", body: new Blob([], { type: "text/plain" }) },
        { name: "fine.txt", body: new Blob(["ok"], { type: "text/plain" }) },
      ]);
      const draft = drafts.state.get().get(targetKey(target));
      assert.deepStrictEqual(
        draft?.files.map((file) => [file._tag, file._tag === "failed" ? file.problem : null]),
        [
          ["failed", "empty"],
          ["uploading", null],
        ],
      );
      yield* waitFor(drafts.state, (state) =>
        (state.get(targetKey(target))?.files ?? []).some((file) => file._tag === "ready"),
      );
      assert.strictEqual(yield* drafts.send(target), "not-ready");

      const [refused] = drafts.state.get().get(targetKey(target))?.files ?? [];
      if (refused === undefined) return assert.fail("No refused file");
      yield* drafts.detach(target, refused.key);
      yield* drafts.setText(target, "just the one");
      assert.strictEqual(yield* drafts.send(target), "sent");
      yield* Queue.take((yield* Fakes).sends);
    }).pipe(Effect.scoped, Effect.provide(client())),
  );
});
