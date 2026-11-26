// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AttachmentId,
  BotId,
  CommandId,
  DeviceId,
  DeviceToken,
  type Entry,
  type EntryId,
  type QuestionEntry,
  type EntryTarget,
  HTTP_PATHS,
  J3Rpcs,
  MemoryPath,
  ModelId,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_INLINE_IMAGE_SIZE,
  MAX_INLINE_IMAGES_SIZE,
  MAX_MESSAGE_LENGTH,
  Conflict,
  Invalid,
  NotFound,
  PROTOCOL_VERSION,
  ProviderId,
  PushToken,
  RoomId,
  ServerInfo,
  MAX_USAGE_TURNS,
  USAGE_PERIOD,
} from "@j3-bots/contracts";
import * as Server from "@j3-bots/server/testing";
import { assert, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ClientRuntime from "../src/client.ts";
import {
  Connection,
  type ConnectionState,
  type ReconnectSettings,
} from "../src/connection/Connection.ts";
import { Actions, cardAction } from "../src/intents/Actions.ts";
import { type ClientStorage, CredentialStore, type DeviceCredential } from "../src/ports.ts";
import { FILE_MARK } from "../src/files/placed.ts";
import { waitFor } from "../src/Store.ts";
import {
  type CardAnswer,
  type ConversationItem,
  type ConversationState,
  Conversations,
  messageStatus,
  targetKey,
} from "../src/stores/Conversations.ts";
import { Details, memorySaveKey } from "../src/stores/Details.ts";
import { Devices } from "../src/stores/Devices.ts";
import { Drafts } from "../src/stores/Drafts.ts";
import { Presence } from "../src/stores/Presence.ts";
import { Roster } from "../src/stores/Roster.ts";
import { Settings } from "../src/stores/Settings.ts";
import { USAGE_PAGE, Usage } from "../src/stores/Usage.ts";
import { SignOut } from "../src/intents/SignOut.ts";
import * as TestPlatform from "./platform.ts";

// The real server's routes, socket and handlers, over the in-memory engine and
// a temporary database. The taps below wrap a few of its handlers, so a test
// can watch a call, hold it or refuse it at an exact point; the server's own
// handler still answers every call a tap lets through.

/** A view a socket reported, with the device the socket belongs to. */
interface ReportedView {
  readonly device: DeviceId;
  readonly target: EntryTarget | null;
}

/** What the taps record, and a gate that holds calls until the test opens it. */
class Taps extends Context.Service<
  Taps,
  {
    readonly gate: Latch.Latch;
    /** Every `message.send` the server received, by command id, as it arrives. */
    readonly sends: Queue.Queue<CommandId>;
    /** Every `card.answer` the server received. */
    readonly answers: Queue.Queue<CommandId>;
    /** The entry each `message.send` command made, on any socket. */
    readonly applied: Map<CommandId, EntryId>;
    /** Texts `message.send` refuses, as the server refuses a message to a bot it no longer has. */
    readonly refusing: Set<string>;
    /** Every view a socket reported, with the device the socket belongs to. */
    readonly views: Queue.Queue<ReportedView>;
    /** The moment the server read the turns at, in its last answer to `usage.turns`. */
    readonly turnsRead: { at: DateTime.Utc | null };
    /** How many of the next `usage.turns` reads fail, as the server fails one that breaks. */
    readonly failingReads: { count: number };
    /** How many of the next `usage.turns` reads never answer. */
    readonly silentReads: { count: number };
    /** How many of the next `bot.freshStart` calls fail, as the server fails one that breaks. */
    readonly failingFreshStarts: { count: number };
  }
>()("@j3-bots/client-runtime/test/client.test/Taps") {}

const taps = Layer.effect(
  Taps,
  Effect.gen(function* () {
    return Taps.of({
      gate: yield* Latch.make(true),
      sends: yield* Queue.unbounded<CommandId>(),
      answers: yield* Queue.unbounded<CommandId>(),
      applied: new Map(),
      refusing: new Set(),
      views: yield* Queue.unbounded<ReportedView>(),
      turnsRead: { at: null },
      failingReads: { count: 0 },
      silentReads: { count: 0 },
      failingFreshStarts: { count: 0 },
    });
  }),
);

/** Whether a handler gave its reply for later, as a handler may. */
const isLater = <A, E>(answer: A | Deferred.Deferred<A, E>): answer is Deferred.Deferred<A, E> =>
  Deferred.isDeferred(answer);

/** What a handler answered: its reply, now or once it gives it. */
const replied = <A, E>(answer: A | Deferred.Deferred<A, E>): Effect.Effect<A, E> =>
  isLater(answer) ? Deferred.await(answer) : Effect.succeed(answer);

const tapped = Layer.mergeAll(
  J3Rpcs.toLayerHandler(
    "message.send",
    Effect.gen(function* () {
      const { gate, sends, applied, refusing } = yield* Taps;
      const send = yield* J3Rpcs.accessHandler("message.send");
      return (input, options) =>
        Effect.gen(function* () {
          yield* Queue.offer(sends, input.commandId);
          yield* gate.await;
          if (refusing.has(input.text)) return yield* new NotFound({ resource: "bot" });
          const entryId = yield* send(input, options).pipe(Effect.flatMap(replied));
          applied.set(input.commandId, entryId);
          return entryId;
        });
    }),
  ),
  J3Rpcs.toLayerHandler(
    "card.answer",
    Effect.gen(function* () {
      const { gate, answers } = yield* Taps;
      const answer = yield* J3Rpcs.accessHandler("card.answer");
      return (input, options) =>
        Queue.offer(answers, input.commandId).pipe(
          Effect.andThen(gate.await),
          Effect.andThen(answer(input, options)),
        );
    }),
  ),
  J3Rpcs.toLayerHandler(
    "client.view",
    Effect.gen(function* () {
      const { views } = yield* Taps;
      const device = yield* Server.CurrentDevice;
      const view = yield* J3Rpcs.accessHandler("client.view");
      return (input, options) =>
        Queue.offer(views, { device: device.id, target: input.target }).pipe(
          Effect.andThen(view(input, options)),
        );
    }),
  ),
  J3Rpcs.toLayerHandler(
    "usage.turns",
    Effect.gen(function* () {
      const { turnsRead, failingReads, silentReads } = yield* Taps;
      const read = yield* J3Rpcs.accessHandler("usage.turns");
      return (input, options) =>
        Effect.suspend(() => {
          if (failingReads.count > 0) {
            failingReads.count -= 1;
            return Effect.die("The turns could not be read");
          }
          if (silentReads.count > 0) {
            silentReads.count -= 1;
            return Effect.never;
          }
          return Effect.gen(function* () {
            const turns = yield* read(input, options).pipe(Effect.flatMap(replied));
            turnsRead.at = turns.readAt;
            return turns;
          });
        });
    }),
  ),
  J3Rpcs.toLayerHandler(
    "bot.freshStart",
    Effect.gen(function* () {
      const { failingFreshStarts } = yield* Taps;
      const freshStart = yield* J3Rpcs.accessHandler("bot.freshStart");
      return (input, options) =>
        Effect.suspend(() => {
          if (failingFreshStarts.count === 0) return freshStart(input, options);
          failingFreshStarts.count -= 1;
          return Effect.die("The fresh start broke");
        });
    }),
  ),
);

const server = Server.layer(tapped).pipe(Layer.provideMerge(taps));

/**
 * A fresh client of the test server, with `stored` as its saved credential.
 * Two clients on one `device` are one device before and after a reload, or
 * two tabs of one browser. Each builds every service of its own, as a tab does.
 */
const client = (
  stored: Option.Option<DeviceCredential> = Option.none(),
  device = TestPlatform.makeDevice(),
  http?: Layer.Layer<HttpClient.HttpClient>,
  reconnect?: Partial<ReconnectSettings>,
) =>
  Layer.unwrap(
    Effect.map(Server.origin, (origin) =>
      Layer.fresh(
        ClientRuntime.layer.pipe(
          Layer.provideMerge(TestPlatform.layer(origin, stored, device, http, reconnect)),
        ),
      ),
    ),
  );

/** For a test of a request that never answers: it gives up soon. */
const SHORT_TIMEOUT: Partial<ReconnectSettings> = { requestTimeout: Duration.seconds(1) };

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

const encodeServerInfo = Schema.encodeSync(Schema.toCodecJson(ServerInfo));

/** The release a server of another protocol says it runs. */
const OTHER_RELEASE = "9.8.7";

/**
 * The server as a release of protocol `version` would answer the server
 * check, as one built before or after this client: all else is this server's.
 */

const speakingProtocol = (version: number) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const server = yield* HttpClient.HttpClient;
      return HttpClient.make((request, url) =>
        url.pathname === HTTP_PATHS.server
          ? server.execute(request).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(ServerInfo)),
              Effect.orDie,
              Effect.map((info) =>
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    encodeServerInfo({ ...info, protocolVersion: version, version: OTHER_RELEASE }),
                  ),
                ),
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

/** Something between the client and the server that holds each request to `path` while `open` is closed. */
const heldAt = (path: string, open: Latch.Latch) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const server = yield* HttpClient.HttpClient;
      return HttpClient.make((request, url) =>
        url.pathname === path
          ? open.await.pipe(Effect.andThen(server.execute(request)))
          : server.execute(request),
      );
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

/**
 * Something between the client and the server that answers the first upload
 * with a failure the next attempt may not meet, once `open` opens, and passes
 * the rest on. Records the bearer of every upload.
 */
const uploadsFailingOnce = (open: Latch.Latch, bearers: Array<string>) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const server = yield* HttpClient.HttpClient;
      return HttpClient.make((request, url) => {
        if (url.pathname !== HTTP_PATHS.attachments) return server.execute(request);
        bearers.push(request.headers["authorization"] ?? "");
        if (bearers.length > 1) return server.execute(request);
        return open.await.pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
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

const decodeOutboxRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })),
);
/** Whether an outbox record holds a message still to send, rather than what became of one. */
const pending = (record: string | undefined) =>
  record !== undefined &&
  Option.exists(decodeOutboxRecord(record), ({ _tag }) => _tag === "message");
const sent = (record: string | undefined) => !pending(record);
/** The command ids of the messages the device keeps to send. */
const unsent = (storage: ClientStorage["Service"]) =>
  storage.readAll("outbox").pipe(
    Effect.orDie,
    Effect.map((records) =>
      [...records].flatMap(([commandId, record]) => (pending(record) ? [commandId] : [])),
    ),
  );
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

/**
 * How the server would tell the device of `entry` in `target` now: on the
 * socket it has open (`live`), with a push, since it has none (`push`), or not
 * at all.
 */
const reachedBy = (deviceId: DeviceId, target: EntryTarget, entry: Entry) =>
  Effect.gen(function* () {
    const recipients = yield* (yield* Server.Presence).recipients(target, entry);
    if (recipients?.live.includes(deviceId)) return "live";
    if (recipients?.push.includes(deviceId)) return "push";
    return "none";
  });

/**
 * How many turns the server holds of the day, once each of `bots` ran its
 * first: the one the engine runs for a new bot.
 */
const firstTurnsRan = (bots: ReadonlyArray<BotId>) =>
  Effect.gen(function* () {
    yield* Effect.forEach(bots, Server.turnRecorded, { discard: true });
    const { turns } = yield* (yield* Server.Usage).turns({ period: USAGE_PERIOD, limit: 10_000 });
    return turns.length;
  });

/**
 * Turns of a new bot, as the server records them: `count`, one a minute back
 * from now, and with `dayBefore` one more from the day before. Returns how
 * many turns of the day the server then holds: those, and the first turn of
 * the new bot and of each of `others`.
 */
const setTurns = (count: number, dayBefore = false, others: ReadonlyArray<BotId> = []) =>
  Effect.gen(function* () {
    const botId = yield* createBot("Ana");
    const ran = yield* firstTurnsRan([botId, ...others]);
    const now = yield* DateTime.now;
    const minutesAgo = (minutes: number) => DateTime.subtract(now, { minutes });
    yield* Server.pastTurns(
      botId,
      ProviderId.make("claude"),
      Arr.appendAll(
        Arr.makeBy(count, (index) => minutesAgo(index + 1)),
        dayBefore ? [minutesAgo(25 * 60)] : [],
      ),
    );
    return ran + count;
  });

/** A room of `members`, created through the client's typed RPC client. */
const createRoom = (name: string, members: ReadonlyArray<BotId>) =>
  Effect.gen(function* () {
    const connection = yield* Connection;
    const commandId = yield* (yield* Actions).commandId;
    const room = yield* connection.call((rpc) => rpc["room.create"]({ commandId, name, members }));
    return { _tag: "room", roomId: room.id } satisfies EntryTarget;
  });

/**
 * Runs `effect` against a server of its own, whose turns are only those its
 * test records and runs: no bot of an earlier test holds one of the turns
 * that may run at once, or counts among the day's.
 */
const onItsOwnServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(server)));

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

const outgoingIn = (state: ConversationState) =>
  state.items.flatMap((item) => (item._tag === "outgoing" ? [item] : []));

/** The platform reports the network gone, and the client follows. */
const goOffline = Effect.gen(function* () {
  yield* (yield* TestPlatform.TestNetwork).set("offline");
  yield* waitFor((yield* Connection).state, (state) => state._tag === "offline");
});

/** A paired device with one bot, from a client that has closed since. */
const pairedDevice = (botName: string, options?: Parameters<typeof TestPlatform.makeDevice>[0]) =>
  Effect.gen(function* () {
    const device = TestPlatform.makeDevice(options);
    const first = yield* Effect.gen(function* () {
      yield* pairAndConnect;
      return { botId: yield* createBot(botName), credential: yield* savedCredential };
    }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
    const target: EntryTarget = { _tag: "conversation", botId: first.botId };
    return { device, target, botId: first.botId, credential: first.credential };
  });

/** Runs `effect` with a wall clock that stands still, and timers that run as usual. */
const atOneInstant = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const live = yield* Clock.Clock;
    const at = live.currentTimeMillisUnsafe();
    const stopped: Clock.Clock = {
      currentTimeMillisUnsafe: () => at,
      currentTimeMillis: Effect.succeed(at),
      currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n,
      currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: live.monotonicTimeNanos,
      sleep: (duration) => live.sleep(duration),
    };
    return yield* effect.pipe(Effect.provideService(Clock.Clock, stopped));
  });

/** A question card the bot raises in the turn it runs, to pick "A" or "B". */
const botAsks = (botId: BotId) => Server.botAsks(botId, "Which one?", ["A", "B"]);

/** The answer that picks the option labelled `label` on a card of `botAsks`. */
const picking = (card: QuestionEntry, label: string) =>
  Effect.gen(function* () {
    const [question] = card.questions;
    const option = question?.options.find((candidate) => candidate.label === label);
    if (question === undefined || option === undefined) {
      return yield* Effect.die(`The card has no option ${label}`);
    }
    return {
      _tag: "question",
      answers: { [question.id]: { optionIds: [option.id], text: null } },
    } satisfies CardAnswer;
  });

/** What a test drives of one device's open client. */
const deviceClient = Effect.gen(function* () {
  const connection = yield* Connection;
  yield* waitFor(connection.state, isConnected);
  return {
    connection,
    deviceId: yield* connection.deviceId,
    conversations: yield* Conversations,
    drafts: yield* Drafts,
    devices: yield* Devices,
    network: yield* TestPlatform.TestNetwork,
  };
});

interface OnDevice extends Effect.Success<typeof deviceClient> {
  readonly storage: TestPlatform.TestDevice["storage"];
}

/**
 * Runs `use` with two devices, A and B, each paired on its own and each with
 * a client open and connected, and a bot both talk to. B's client closes
 * first, while A's is still open. Once both have closed, what the taps
 * received from them is not left for the next test.
 */
const acrossDevices = <A, E, R>(
  use: (a: OnDevice, b: OnDevice, botId: BotId) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const first = yield* pairedDevice("Shared");
    const second = TestPlatform.makeDevice();
    const secondCredential = yield* Effect.gen(function* () {
      yield* pairAndConnect;
      return yield* savedCredential;
    }).pipe(Effect.scoped, Effect.provide(client(Option.none(), second)));

    return yield* Effect.gen(function* () {
      const a: OnDevice = { ...(yield* deviceClient), storage: first.device.storage };
      return yield* Effect.gen(function* () {
        const b: OnDevice = { ...(yield* deviceClient), storage: second.storage };
        return yield* use(a, b, first.botId);
      }).pipe(Effect.scoped, Effect.provide(client(secondCredential, second)));
    }).pipe(
      Effect.scoped,
      Effect.provide(client(first.credential, first.device)),
      Effect.ensuring(
        Effect.gen(function* () {
          const { sends, answers } = yield* Taps;
          yield* Queue.clear(sends);
          yield* Queue.clear(answers);
        }),
      ),
    );
  });

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

  it.effect(
    "reads the day's turns while held, a page more on demand, up to what one read takes",
    () =>
      Effect.gen(function* () {
        yield* pairAndConnect;
        // More than one read takes within the day, and one turn from the day before.
        yield* setTurns(1_100, true);

        const view = yield* (yield* Usage).open;
        let state = yield* waitFor(view.state, (next) => next.read._tag === "ready");
        // The moment the server read them, not the client's.
        const { turnsRead } = yield* Taps;
        assert.isTrue(
          state.read._tag === "ready" &&
            turnsRead.at !== null &&
            DateTime.Equivalence(state.read.value.readAt, turnsRead.at),
        );
        const steps: Array<[number, boolean]> = [];
        while (state.read._tag === "ready") {
          steps.push([state.read.value.turns.length, state.read.value.canLoadMore]);
          if (!state.read.value.canLoadMore) break;
          yield* view.loadMore;
          state = yield* waitFor(view.state, (next) => !next.loadingMore);
        }
        assert.deepStrictEqual(steps, [
          [USAGE_PAGE, true],
          [2 * USAGE_PAGE, true],
          [3 * USAGE_PAGE, true],
          [4 * USAGE_PAGE, true],
          [MAX_USAGE_TURNS, false],
        ]);
        assert.isTrue(state.read._tag === "ready" && state.read.value.hasMore);
      }).pipe(Effect.scoped, Effect.provide(client()), onItsOwnServer),
  );

  it.effect("shows a read that gets no answer in time as failed, keeping the turns read", () =>
    Effect.gen(function* () {
      const { device, credential, botId } = yield* pairedDevice("Ana");
      yield* Effect.gen(function* () {
        yield* waitFor((yield* Connection).state, isConnected);
        const day = yield* setTurns(USAGE_PAGE + 50, false, [botId]);
        const view = yield* (yield* Usage).open;
        yield* waitFor(view.state, (state) => state.read._tag === "ready");

        (yield* Taps).silentReads.count = 1;
        yield* view.loadMore;
        const failed = yield* waitFor(view.state, (state) => state.failed);
        assert.deepStrictEqual(
          failed.read._tag === "ready" && [failed.read.value.turns.length, failed.loadingMore],
          [USAGE_PAGE, false],
        );

        yield* view.retry;
        const read = yield* waitFor(view.state, (state) => !state.loadingMore && !state.failed);
        assert.strictEqual(read.read._tag === "ready" && read.read.value.turns.length, day);
      }).pipe(Effect.scoped, Effect.provide(client(credential, device, undefined, SHORT_TIMEOUT)));
    }).pipe(onItsOwnServer),
  );

  it.effect(
    "shows a read whose answer the client cannot decode on an open socket as failed, keeping the turns read",
    () =>
      Effect.gen(function* () {
        yield* pairAndConnect;
        const network = yield* TestPlatform.TestNetwork;
        const day = yield* setTurns(USAGE_PAGE + 50);
        const view = yield* (yield* Usage).open;
        yield* waitFor(view.state, (state) => state.read._tag === "ready");

        yield* network.corruptReplies(true);
        yield* view.loadMore;
        const failed = yield* waitFor(view.state, (state) => state.failed);
        assert.deepStrictEqual(
          failed.read._tag === "ready" && [failed.read.value.turns.length, failed.loadingMore],
          [USAGE_PAGE, false],
        );

        yield* network.corruptReplies(false);
        yield* view.retry;
        const read = yield* waitFor(view.state, (state) => !state.loadingMore && !state.failed);
        assert.strictEqual(read.read._tag === "ready" && read.read.value.turns.length, day);
      }).pipe(Effect.scoped, Effect.provide(client()), onItsOwnServer),
  );

  it.effect("says the first read of the turns failed, and reads them on retry", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const day = yield* setTurns(3);
      (yield* Taps).failingReads.count = 1;

      const view = yield* (yield* Usage).open;
      const failed = yield* waitFor(view.state, (state) => state.failed);
      assert.strictEqual(failed.read._tag, "loading");

      yield* view.retry;
      const read = yield* waitFor(view.state, (state) => state.read._tag === "ready");
      assert.deepStrictEqual(
        read.read._tag === "ready" && [read.read.value.turns.length, read.failed],
        [day, false],
      );
    }).pipe(Effect.scoped, Effect.provide(client()), onItsOwnServer),
  );

  it.effect(
    "keeps the turns read when reading more fails, marks them stale offline, and reads more on the next socket",
    () =>
      Effect.gen(function* () {
        yield* pairAndConnect;
        const network = yield* TestPlatform.TestNetwork;
        // Fewer than a page more within the day, and one turn from the day before.
        const day = yield* setTurns(USAGE_PAGE + 50, true);
        const view = yield* (yield* Usage).open;
        yield* waitFor(view.state, (state) => state.read._tag === "ready");

        (yield* Taps).failingReads.count = 1;
        yield* view.loadMore;
        const failed = yield* waitFor(view.state, (state) => state.failed);
        assert.deepStrictEqual(
          failed.read._tag === "ready" && [failed.read.value.turns.length, failed.loadingMore],
          [USAGE_PAGE, false],
        );

        yield* network.set("offline");
        yield* network.dropSockets;
        const offline = yield* waitFor(
          view.state,
          (state) => state.read._tag === "ready" && state.read.stale,
        );
        assert.strictEqual(
          offline.read._tag === "ready" && offline.read.value.turns.length,
          USAGE_PAGE,
        );

        yield* network.set("online");
        const reread = yield* waitFor(
          view.state,
          (state) => state.read._tag === "ready" && !state.read.stale,
        );
        // The day's turns, all of them, and not the one before it.
        assert.deepStrictEqual(
          reread.read._tag === "ready" && [
            reread.read.value.turns.length,
            reread.read.value.hasMore,
            reread.read.value.canLoadMore,
            reread.failed,
          ],
          [day, false, false, false],
        );
      }).pipe(Effect.scoped, Effect.provide(client()), onItsOwnServer),
  );

  it.effect("keeps a credential it was given without a code, connects, and keeps it", () =>
    Effect.gen(function* () {
      // A credential the server issued to this device by another way than a code.
      const given = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        return yield* savedCredential;
      }).pipe(Effect.scoped, Effect.provide(client()));
      if (Option.isNone(given)) return assert.fail("The pairing was not saved");

      yield* Effect.gen(function* () {
        const connection = yield* Connection;
        yield* waitFor(connection.state, (state) => state._tag === "unpaired");
        yield* connection.adopt(given.value);
        yield* waitFor(connection.state, isConnected);
        assert.strictEqual(yield* connection.deviceId, given.value.deviceId);
        const stored = yield* savedCredential;
        assert.isTrue(Option.isSome(stored) && stored.value.deviceId === given.value.deviceId);
      }).pipe(Effect.scoped, Effect.provide(client()));
    }),
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
      const { gate, sends } = yield* Taps;
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

        assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "signed-out" });

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

      assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "signed-out" });

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

      assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "still-listed" });

      const unpaired = yield* waitFor(connection.state, (state) => state._tag === "unpaired");
      assert.deepStrictEqual(unpaired, { _tag: "unpaired", reason: "still-listed" });
      assert.isTrue(Option.isNone(yield* (yield* CredentialStore).load));
      const listed = yield* (yield* Server.Devices).list(deviceId);
      assert.isTrue(listed.some((device) => device.id === deviceId));
    }).pipe(Effect.provide(client())),
  );

  it.effect("says the server ended access when another tab heard it first", () =>
    Effect.gen(function* () {
      const { device, credential } = yield* pairedDevice("Heard elsewhere");
      if (Option.isNone(credential)) return assert.fail("The pairing was not saved");
      const tickets = yield* Latch.make(true);

      yield* Effect.gen(function* () {
        const other = yield* Connection;
        yield* waitFor(other.state, isConnected);

        yield* Effect.gen(function* () {
          const leaving = yield* Connection;
          yield* waitFor(leaving.state, isConnected);
          // The revocation reaches the server; its answer never comes back,
          // and this tab asks for no new socket until the other tab followed.
          yield* (yield* TestPlatform.TestNetwork).loseReplies(true);
          yield* tickets.close;
          const signingOut = yield* (yield* SignOut).run.pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          // The other tab hears the server refuse the device, and deletes its credential.
          yield* waitFor(other.state, (state) => state._tag === "unpaired");
          yield* waitFor(leaving.state, (state) => state._tag === "unpaired");
          yield* tickets.open;

          assert.deepStrictEqual(yield* Fiber.join(signingOut), { _tag: "signed-out" });
        }).pipe(
          Effect.scoped,
          Effect.provide(client(credential, device, heldAt(HTTP_PATHS.socketTicket, tickets))),
        );

        const listed = yield* (yield* Server.Devices).list(credential.value.deviceId);
        assert.isFalse(
          listed.some((listedDevice) => listedDevice.id === credential.value.deviceId),
        );
      }).pipe(
        Effect.scoped,
        Effect.ensuring(tickets.open),
        Effect.provide(client(credential, device)),
      );
    }),
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
        Effect.provide(
          client(credential, device, neverAnswers(HTTP_PATHS.socketTicket), SHORT_TIMEOUT),
        ),
      );
    }),
  );

  it.effect(
    "refuses a server of the protocol before or after its own, paired or not, keeping the pairing",
    () =>
      Effect.gen(function* () {
        for (const version of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1]) {
          const refusal = yield* Effect.gen(function* () {
            const { code } = yield* (yield* Server.Devices).startPairing;
            return yield* (yield* Connection)
              .pair({ code, deviceName: "Test client" })
              .pipe(Effect.flip);
          }).pipe(
            Effect.scoped,
            Effect.provide(client(Option.none(), undefined, speakingProtocol(version))),
          );
          assert.deepStrictEqual(refusal.reason, {
            _tag: "incompatible-server",
            serverProtocol: version,
            serverVersion: OTHER_RELEASE,
          });

          const device = TestPlatform.makeDevice();
          const credential = yield* Effect.gen(function* () {
            yield* pairAndConnect;
            return yield* savedCredential;
          }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
          yield* Effect.gen(function* () {
            const refused = yield* waitFor(
              (yield* Connection).state,
              (state) => state._tag === "incompatible",
            );
            assert.deepStrictEqual(refused, {
              _tag: "incompatible",
              serverProtocol: version,
              serverVersion: OTHER_RELEASE,
            });
            assert.isTrue(Option.isSome(yield* (yield* CredentialStore).load));
          }).pipe(
            Effect.scoped,
            Effect.provide(client(credential, device, speakingProtocol(version))),
          );
        }
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
        client(
          Option.none(),
          TestPlatform.makeDevice(),
          neverAnswers(HTTP_PATHS.attachments, 1),
          SHORT_TIMEOUT,
        ),
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

  it.effect(
    "has no socket open on the server in the background, so it is pushed to, and opens one when the app returns",
    () =>
      Effect.gen(function* () {
        const { views } = yield* Taps;
        const connection = yield* Connection;
        const lifecycle = yield* TestPlatform.TestLifecycle;
        yield* pairAndConnect;
        const deviceId = yield* connection.deviceId;
        const commandId = yield* (yield* Actions).commandId;
        yield* connection.call((rpc) =>
          rpc["push.register"]({
            commandId,
            provider: "expo",
            token: PushToken.make("ExponentPushToken[background]"),
            platform: "android",
            language: "en",
          }),
        );
        const courier = yield* createBot("Courier");
        const target: EntryTarget = { _tag: "conversation", botId: courier };
        const said = yield* botSays(courier, "Back soon");
        assert.strictEqual(yield* reachedBy(deviceId, target, said), "live");
        // Each socket reports the view as it opens.
        yield* Queue.take(views);

        yield* lifecycle.set("background");
        yield* reachedBy(deviceId, target, said).pipe(
          Effect.repeat({ until: (way) => way === "push", schedule: Schedule.spaced("5 millis") }),
        );
        assert.deepStrictEqual(connection.state.get(), { _tag: "background" });

        yield* lifecycle.set("foreground");
        yield* waitFor(connection.state, isConnected);
        yield* Queue.take(views);
        assert.strictEqual(yield* reachedBy(deviceId, target, said), "live");
      }).pipe(Effect.provide(client())),
  );

  it.effect(
    "goes to the background from offline, and back to offline while the network is out",
    () =>
      Effect.gen(function* () {
        yield* pairAndConnect;
        const connection = yield* Connection;
        const network = yield* TestPlatform.TestNetwork;
        const lifecycle = yield* TestPlatform.TestLifecycle;
        yield* network.set("offline");
        yield* waitFor(connection.state, (state) => state._tag === "offline");

        yield* lifecycle.set("background");
        yield* waitFor(connection.state, (state) => state._tag === "background");
        yield* lifecycle.set("foreground");
        yield* waitFor(connection.state, (state) => state._tag === "offline");
        yield* network.set("online");
        yield* waitFor(connection.state, isConnected);
      }).pipe(Effect.provide(client())),
  );

  it.effect(
    "goes to the background while it waits to reconnect, and connects when the app returns",
    () =>
      Effect.gen(function* () {
        yield* pairAndConnect;
        const connection = yield* Connection;
        const network = yield* TestPlatform.TestNetwork;
        const lifecycle = yield* TestPlatform.TestLifecycle;
        yield* network.dropSockets;
        yield* waitFor(connection.state, (state) => state._tag === "waiting");

        yield* lifecycle.set("background");
        yield* waitFor(connection.state, (state) => state._tag === "background");
        yield* lifecycle.set("foreground");
        // Long before the wait it was in would have ended.
        yield* waitFor(connection.state, isConnected);
      }).pipe(
        Effect.provide(
          client(Option.none(), TestPlatform.makeDevice(), undefined, {
            initialDelay: Duration.minutes(10),
            maxDelay: Duration.minutes(10),
          }),
        ),
      ),
  );

  it.effect("signs out in the background without waiting for the app to return", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const connection = yield* Connection;
      const deviceId = yield* connection.deviceId;
      const lifecycle = yield* TestPlatform.TestLifecycle;
      yield* lifecycle.set("background");
      yield* waitFor(connection.state, (state) => state._tag === "background");

      // With no socket, the server is not asked.
      assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "still-listed" });

      const unpaired = yield* waitFor(connection.state, (state) => state._tag === "unpaired");
      assert.deepStrictEqual(unpaired, { _tag: "unpaired", reason: "still-listed" });
      assert.isTrue(Option.isNone(yield* (yield* CredentialStore).load));
      const listed = yield* (yield* Server.Devices).list(deviceId);
      assert.isTrue(listed.some((device) => device.id === deviceId));
    }).pipe(Effect.provide(client())),
  );

  it.effect("keeps each section's save under way through a disconnection until it is saved", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const settings = yield* Settings;
      const network = yield* TestPlatform.TestNetwork;
      const connection = yield* Connection;
      const loaded = yield* waitFor(settings.state, (state) => state._tag === "ready");
      if (loaded._tag !== "ready") return assert.fail("No settings");
      const previews = !loaded.value.notifications.previews;

      yield* network.set("offline");
      yield* waitFor(connection.state, (state) => state._tag === "offline");
      const profile = yield* settings
        .update({ section: "profile", changes: { operatorName: "Ana" } })
        .pipe(Effect.forkChild({ startImmediately: true }));
      // A switch saved meanwhile leaves the profile's save alone.
      const notifications = yield* settings
        .update({ section: "notifications", changes: { previews } })
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.deepStrictEqual(settings.saves.profile.get(), {
        _tag: "saving",
        changes: { operatorName: "Ana" },
      });
      assert.deepStrictEqual(settings.saves.notifications.get(), {
        _tag: "saving",
        changes: { previews },
      });

      yield* network.set("online");
      assert.strictEqual((yield* Fiber.join(profile))._tag, "done");
      assert.strictEqual((yield* Fiber.join(notifications))._tag, "done");
      assert.deepStrictEqual(settings.saves.profile.get(), {
        _tag: "saved",
        changes: { operatorName: "Ana" },
      });
      assert.deepStrictEqual(settings.saves.notifications.get(), {
        _tag: "saved",
        changes: { previews },
      });
      const saved = settings.state.get();
      assert.strictEqual(saved._tag === "ready" && saved.value.operatorName, "Ana");
      assert.strictEqual(saved._tag === "ready" && saved.value.notifications.previews, previews);
    }).pipe(Effect.scoped, Effect.provide(client())),
  );

  it.effect("reads a conversation again after another device marked it unread", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const botId = yield* createBot("Echo");
      const target: EntryTarget = { _tag: "conversation", botId };
      const said = yield* botSays(botId, "Here is the report.");
      const roster = (yield* Roster).state;
      const unread = (wanted: boolean) =>
        waitFor(
          roster,
          (state) =>
            state._tag === "ready" &&
            state.value.some(
              (item) => item._tag === "bot" && item.bot.id === botId && item.unread === wanted,
            ),
        );
      const conversation = yield* (yield* Conversations).open(target);
      yield* waitFor(conversation.state, (state) => state.phase === "ready");
      yield* conversation.markRead(said.order);
      yield* unread(false);

      yield* (yield* Server.Entries).markUnread({ commandId: CommandId.make("elsewhere"), target });
      yield* unread(true);
      // The operator comes back to it: the same entry seen again is a read the server needs.
      yield* conversation.markRead(said.order);

      yield* unread(false);
    }).pipe(Effect.scoped, Effect.provide(client())),
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
      const { gate, sends } = yield* Taps;
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
      const { gate, answers } = yield* Taps;
      const conversations = yield* Conversations;
      const actions = yield* Actions;
      const botId = yield* createBot("Asker");
      const card = yield* botAsks(botId);
      const conversation = yield* conversations.open({ _tag: "conversation", botId });
      yield* waitFor(conversation.state, (state) => entryIds(state).includes(card.id));

      yield* gate.close;
      const a = yield* picking(card, "A");
      const pick = (answer: CardAnswer) => conversations.answerCard(card.id, answer);
      const first = yield* Effect.forkChild(pick(a));
      yield* waitFor(
        actions.state,
        (state) => state.get(cardAction(card.id))?._tag === "submitting",
      );
      const second = yield* Effect.forkChild(pick(yield* picking(card, "B")));
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
        answers: a.answers,
      });
      // Once the resolved card has arrived, nothing is held for it any more.
      yield* waitFor(actions.state, (state) => !state.has(cardAction(card.id)));
    }).pipe(Effect.scoped, Effect.provide(client()), onItsOwnServer),
  );

  // One conversation across devices: two devices, each paired on its own.

  it.effect("shows a message sent on one device on the other", () =>
    acrossDevices((a, b, botId) =>
      Effect.gen(function* () {
        const target: EntryTarget = { _tag: "conversation", botId };
        const onB = yield* b.conversations.open(target);
        yield* waitFor(onB.state, (state) => state.phase === "ready");

        const sent = yield* a.conversations.send({ target, text: "sent from the laptop" });
        if (sent._tag !== "done") return assert.fail(`The message was not sent: ${sent._tag}`);

        const shown = yield* waitFor(onB.state, (state) => entryIds(state).includes(sent.value));
        const message = shown.items.find(
          (item) => item._tag !== "outgoing" && item.id === sent.value,
        );
        assert.strictEqual(message?._tag === "message" && message.text, "sent from the laptop");
      }),
    ),
  );

  it.effect(
    "resolves on one device a question answered on the other, and refuses a late answer",
    () =>
      acrossDevices((a, b, botId) =>
        Effect.gen(function* () {
          const target: EntryTarget = { _tag: "conversation", botId };
          const card = yield* botAsks(botId);
          const onA = yield* a.conversations.open(target);
          const onB = yield* b.conversations.open(target);
          yield* waitFor(onA.state, (state) => entryIds(state).includes(card.id));
          yield* waitFor(onB.state, (state) => entryIds(state).includes(card.id));

          const pickedOnB = yield* picking(card, "B");
          assert.deepStrictEqual(yield* b.conversations.answerCard(card.id, pickedOnB), {
            _tag: "done",
            value: undefined,
          });
          const statusOn = (state: ConversationState) => {
            const item = state.items.find(
              (candidate) => candidate._tag !== "outgoing" && candidate.id === card.id,
            );
            return item?._tag === "question" ? item.status : null;
          };
          const resolved = yield* waitFor(
            onA.state,
            (state) => statusOn(state)?._tag !== "pending",
          );
          const answeredOnB: ReturnType<typeof statusOn> = {
            _tag: "answered",
            answers: pickedOnB.answers,
          };
          assert.deepStrictEqual(statusOn(resolved), answeredOnB);

          const late = yield* a.conversations.answerCard(card.id, yield* picking(card, "A"));
          if (late._tag !== "failed" || late.failure._tag !== "refused") {
            return assert.fail(`A resolved question took another answer: ${late._tag}`);
          }
          const refusal = late.failure.error;
          assert.strictEqual(refusal._tag === "Conflict" && refusal.reason, "card-closed");
          assert.deepStrictEqual(statusOn(onA.state.get()), answeredOnB);
        }),
      ).pipe(onItsOwnServer),
  );

  it.effect(
    "sends a message written offline once it reconnects, once, as another device watches",
    () =>
      acrossDevices((a, b, botId) =>
        Effect.gen(function* () {
          const target: EntryTarget = { _tag: "conversation", botId };
          const onA = yield* a.conversations.open(target);
          const onB = yield* b.conversations.open(target);
          yield* waitFor(onA.state, (state) => state.phase === "ready");
          yield* waitFor(onB.state, (state) => state.phase === "ready");

          const text = "written on the train";
          yield* a.network.set("offline");
          yield* waitFor(a.connection.state, (state) => state._tag === "offline");
          yield* a.drafts.setText(target, text);
          assert.strictEqual(yield* a.drafts.send(target), "sent");
          const [outgoing] = outgoingIn(onA.state.get());
          if (outgoing === undefined) return assert.fail("The message is not shown as on its way");
          // Any copy counts, whatever command made it.
          const isIt = (item: ConversationItem) => item._tag === "message" && item.text === text;

          yield* a.network.set("online");
          yield* whenStored(a.storage, "outbox", outgoing.commandId, sent);
          const kept = yield* (yield* Server.Entries).latest(target, 100);
          assert.strictEqual(
            kept.filter((entry) => entry._tag === "message" && entry.text === text).length,
            1,
          );
          const { sends } = yield* Taps;
          const sentCommands = yield* Queue.clear(sends);
          assert.deepStrictEqual(
            sentCommands.filter((commandId) => commandId === outgoing.commandId),
            [outgoing.commandId],
          );

          const onBNow = yield* waitFor(onB.state, (state) => state.items.some(isIt));
          assert.strictEqual(onBNow.items.filter(isIt).length, 1);
          const onANow = yield* waitFor(
            onA.state,
            (state) => outgoingIn(state).length === 0 && state.items.some(isIt),
          );
          assert.strictEqual(onANow.items.filter(isIt).length, 1);
        }),
      ),
  );

  it.effect("keeps one device's drafts when another device is revoked", () =>
    acrossDevices((a, b, botId) =>
      Effect.gen(function* () {
        const target: EntryTarget = { _tag: "conversation", botId };
        const key = targetKey(target);
        yield* a.drafts.setText(target, "half a reply on A");
        yield* b.drafts.setText(target, "a note on B");
        yield* whenStored(a.storage, "drafts", key, holds("half a reply on A"));
        yield* whenStored(b.storage, "drafts", key, holds("a note on B"));

        assert.deepStrictEqual(yield* a.devices.revoke(b.deviceId), {
          _tag: "done",
          value: undefined,
        });
        // B's pairing ended, and its drafts went with it, there and on the device.
        yield* waitFor(b.connection.state, (state) => state._tag === "unpaired");
        yield* waitFor(b.drafts.state, (drafts) => drafts.size === 0);
        yield* whenStored(b.storage, "drafts", key, (record) => !present(record));

        assert.strictEqual(a.drafts.state.get().get(key)?.text, "half a reply on A");
        assert.isTrue(
          holds("half a reply on A")(
            (yield* a.storage.readAll("drafts").pipe(Effect.orDie)).get(key),
          ),
        );
        assert.isTrue(isConnected(a.connection.state.get()));
      }),
    ),
  );

  it.effect("sends a message an earlier launch left unsent, once", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Taps;
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
      yield* whenStored(device.storage, "outbox", first.commandId, pending);

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
        yield* whenStored(device.storage, "outbox", first.commandId, sent);
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("sends two messages queued offline in the order they were written", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const { gate, sends } = yield* Taps;
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

  it.effect("is saving a draft until the device keeps the file it shows uploaded", () =>
    Effect.gen(function* () {
      const commitGate = yield* Latch.make(true);
      const device = TestPlatform.makeDevice({ commitGate });
      yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const drafts = yield* Drafts;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Careful") };
        const key = targetKey(target);
        yield* commitGate.close;
        yield* drafts.attach(target, [
          { name: "notes.txt", body: new Blob(["notes"], { type: "text/plain" }) },
        ]);

        // Uploaded, but the device does not keep it in the draft yet.
        yield* waitFor(drafts.state, (state) =>
          (state.get(key)?.files ?? []).some((file) => file._tag === "ready"),
        );
        assert.isTrue(drafts.saving.get());
        const before = yield* device.storage.readAll("drafts").pipe(Effect.orDie);
        assert.isFalse(before.has(key));

        yield* commitGate.open;
        yield* waitFor(drafts.saving, (saving) => !saving);
        const after = yield* device.storage.readAll("drafts").pipe(Effect.orDie);
        assert.isTrue(holds("notes.txt")(after.get(key)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(commitGate.open),
        Effect.provide(client(Option.none(), device)),
      );
    }),
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
          mentions: [],
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
      const { gate, sends } = yield* Taps;
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
          assert.strictEqual((yield* unsent(device.storage)).length, 1);
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
        const { gate, sends } = yield* Taps;
        const device = TestPlatform.makeDevice();
        const first = yield* Effect.gen(function* () {
          yield* pairAndConnect;
          const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Echoes") };
          yield* (yield* Drafts).setText(target, "as read");
          yield* whenStored(device.storage, "drafts", targetKey(target), present);
          return { target, credential: yield* savedCredential };
        }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
        const key = targetKey(first.target);
        const outbox = unsent(device.storage);

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
              Option.some({ target: first.target, whileSending: false, displaced: true }),
            );
            assert.isUndefined(two.state.get().get(key));
            yield* whenStored(device.storage, "drafts", key, noDraft);
            assert.strictEqual((yield* outbox).length, 1);

            yield* two.restore(first.target);
            assert.strictEqual(two.state.get().get(key)?.text, "as read, and more");
            yield* whenStored(
              device.storage,
              "drafts",
              key,
              (record) => record?.includes("as read, and more") === true,
            );
            assert.strictEqual((yield* outbox).length, 1);
          }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
        }).pipe(
          Effect.scoped,
          Effect.ensuring(gate.open),
          // A tab the other hears nothing of: what it sent is found only as the other writes.
          Effect.provide(client(first.credential, { ...device, window: device.unannounced })),
        );
      }),
  );

  it.effect("shows in every tab the draft one of them keeps, as it is kept", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        return { botId: yield* createBot("Mirrored"), credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const target: EntryTarget = { _tag: "conversation", botId: first.botId };
      const key = targetKey(target);

      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          const noticed = yield* Stream.runHead(two.changedElsewhere).pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          // What one tab keeps, the other shows, having done nothing itself.
          yield* one.setText(target, "typed in one");
          yield* waitFor(two.state, (state) => state.get(key)?.text === "typed in one");
          assert.deepStrictEqual(
            yield* Fiber.join(noticed),
            Option.some({ target, whileSending: false, displaced: false }),
          );

          // The other goes on from there: nothing is displaced, and the first shows it.
          yield* two.setText(target, "typed in one, then in two");
          yield* waitFor(
            one.state,
            (state) => state.get(key)?.text === "typed in one, then in two",
          );
          assert.isFalse(two.offers.get().has(key));
          assert.isFalse(one.offers.get().has(key));

          // Emptied in one, it is empty in the other.
          yield* one.setText(target, "");
          yield* waitFor(two.state, (state) => !state.has(key));
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("sends from one tab after another tab wrote and sent the same draft", () =>
    Effect.gen(function* () {
      const { sends } = yield* Taps;
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        return { botId: yield* createBot("Relayed"), credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const target: EntryTarget = { _tag: "conversation", botId: first.botId };
      const key = targetKey(target);

      yield* Effect.gen(function* () {
        // This tab is open all along, and types only at the end.
        const two = yield* Drafts;
        yield* Effect.gen(function* () {
          const one = yield* Drafts;
          yield* one.setText(target, "from one");
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
          assert.strictEqual(yield* one.send(target), "sent");
          yield* Queue.take(sends);
          yield* whenStored(device.storage, "drafts", key, noDraft);
          yield* waitFor(two.state, (state) => !state.has(key));
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));

        // Typed and sent at once, before this tab has kept it: it goes, and nothing is put aside.
        yield* two.setText(target, "from two");
        assert.strictEqual(yield* two.send(target), "sent");
        yield* Queue.take(sends);
        assert.isFalse(two.offers.get().has(key));
        yield* whenStored(device.storage, "drafts", key, noDraft);
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
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
            Option.some({ target: first.target, whileSending: false, displaced: true }),
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
            Option.some({ target: first.target, whileSending: true, displaced: true }),
          );
          assert.strictEqual(two.state.get().get(key)?.text, "shared, from one");
          assert.strictEqual((yield* unsent(device.storage)).length, 0);
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(
        Effect.scoped,
        // A tab the other hears nothing of: its change is found only as the other writes.
        Effect.provide(client(first.credential, { ...device, window: device.unannounced })),
      );
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
        yield* Queue.take((yield* Taps).sends);

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
          // Its file follows the text the other tab kept.
          assert.strictEqual(shown?.text, `shared, from one${FILE_MARK}`);
          assert.deepStrictEqual(
            shown?.files.map((file) => [file._tag, file._tag === "ready" ? null : file.name]),
            [["uploading", "slow.txt"]],
          );
          assert.deepStrictEqual(
            notice,
            Option.some({ target: first.target, whileSending: false, displaced: true }),
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
          // Its file follows the text the other tab kept.
          assert.strictEqual(shown?.text, `shared, from one${FILE_MARK}`);
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
      }).pipe(
        Effect.scoped,
        // A tab the other hears nothing of: its change is found only as the other writes.
        Effect.provide(client(first.credential, { ...device, window: device.unannounced })),
      );
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
            Option.some({ target: first.target, whileSending: true, displaced: false }),
          );
          assert.strictEqual((yield* unsent(device.storage)).length, 0);
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("offers back mentions another tab displaced with the same text", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const botId = yield* createBot("Wren");
        const target: EntryTarget = { _tag: "conversation", botId };
        yield* (yield* Drafts).setText(target, "shared");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        return { target, botId, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const key = targetKey(first.target);
      const text = "@Wren, have a look";
      const picked = { _tag: "bot", botId: first.botId, label: "Wren", position: 0 } as const;

      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          // One tab types the name; the other picks it, in the same text.
          yield* one.setText(first.target, text);
          yield* whenStored(device.storage, "drafts", key, holds("have a look"));
          yield* two.setText(first.target, text, [picked]);
          yield* waitFor(
            two.state,
            (state) => state.get(key)?.text === text && state.get(key)?.mentions.length === 0,
          );

          // The pick is not lost without a word: it is on offer, and comes back.
          assert.isTrue(two.offers.get().has(key));
          yield* two.restore(first.target);
          assert.deepStrictEqual(two.state.get().get(key)?.mentions, [picked]);
          yield* whenStored(device.storage, "drafts", key, holds('"label":"Wren"'));
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("keeps offering text another tab displaced through a later change", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Offered") };
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
          const notices = yield* two.changedElsewhere.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* two.setText(first.target, "shared, from two");
          yield* waitFor(two.state, (state) => state.get(key)?.text === "shared, from one");

          // Before this tab restores its text, the other tab clears the draft,
          // and a file this tab uploads finds it changed again.
          yield* one.setText(first.target, "");
          yield* whenStored(device.storage, "drafts", key, noDraft);
          yield* two.attach(first.target, [
            { name: "later.txt", body: new Blob(["later"], { type: "text/plain" }) },
          ]);

          // The second change displaced nothing new: the first offer stays.
          assert.deepStrictEqual(
            [...(yield* Fiber.join(notices))],
            [
              { target: first.target, whileSending: false, displaced: true },
              { target: first.target, whileSending: false, displaced: false },
            ],
          );
          yield* two.restore(first.target);
          yield* whenStored(
            device.storage,
            "drafts",
            key,
            (record) => holds("from two")(record) && holds("later.txt")(record),
          );
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("offers the newer of two texts another tab displaced", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Twice") };
        yield* (yield* Drafts).setText(target, "shared");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        return { target, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const key = targetKey(first.target);

      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          yield* one.setText(first.target, "from one");
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
          yield* two.setText(first.target, "older, from two");
          yield* waitFor(two.state, (state) => state.get(key)?.text === "from one");
          const older = two.offers.get().get(key);

          yield* one.setText(first.target, "from one again");
          yield* whenStored(device.storage, "drafts", key, holds("from one again"));
          yield* two.setText(first.target, "newer, from two");
          yield* waitFor(two.state, (state) => state.get(key)?.text === "from one again");
          // A new offer, though one was already in view, so it is announced again.
          const newer = two.offers.get().get(key);
          assert.isTrue(older !== undefined && newer !== undefined && newer > older);

          yield* two.restore(first.target);
          yield* whenStored(device.storage, "drafts", key, holds("newer, from two"));
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }).pipe(
        Effect.scoped,
        // A tab the other hears nothing of: each change is found only as the other writes.
        Effect.provide(client(first.credential, { ...device, window: device.unannounced })),
      );
    }),
  );

  it.effect("offers displaced text until it is restored or dismissed, not only when told", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Held") };
        yield* (yield* Drafts).setText(target, "shared");
        yield* whenStored(device.storage, "drafts", targetKey(target), present);
        return { target, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
      const key = targetKey(first.target);

      yield* Effect.gen(function* () {
        const one = yield* Drafts;
        yield* Effect.gen(function* () {
          const two = yield* Drafts;
          yield* one.setText(first.target, "from one");
          yield* whenStored(device.storage, "drafts", key, holds("from one"));
          yield* two.setText(first.target, "from two");
          yield* waitFor(two.state, (state) => state.get(key)?.text === "from one");
          assert.isTrue(two.offers.get().has(key));

          // Long after the notice, and after this tab writes something else, it is still on offer.
          yield* two.setText(first.target, "from one, and two goes on");
          yield* whenStored(device.storage, "drafts", key, holds("two goes on"));
          assert.isTrue(two.offers.get().has(key));

          yield* two.dismiss(first.target);
          assert.isFalse(two.offers.get().has(key));
          yield* two.restore(first.target);
          assert.strictEqual(two.state.get().get(key)?.text, "from one, and two goes on");
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
      const { gate, sends } = yield* Taps;
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
      const { sends } = yield* Taps;
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
          const [kept] = yield* unsent(device.storage);
          return kept;
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
        if (commandId === undefined) return assert.fail("No message kept");

        yield* (yield* TestPlatform.TestNetwork).set("online");
        assert.strictEqual(yield* Queue.take(sends), commandId);
        yield* whenStored(device.storage, "outbox", commandId, sent);
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
          assert.strictEqual((yield* unsent(device.storage)).length, 0);
        }).pipe(
          Effect.scoped,
          Effect.provide(client(first.credential, device, neverAnswers(HTTP_PATHS.attachments))),
        );
      }).pipe(
        Effect.scoped,
        // A tab the other hears nothing of: its draft is found only as the other writes.
        Effect.provide(client(first.credential, { ...device, window: device.unannounced })),
      );
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
        .write(
          "drafts",
          key,
          JSON.stringify({
            revision: "earlier",
            pairing: Option.getOrThrow(first.credential).deviceId,
            text: "all of them",
            files,
          }),
        )
        .pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        const drafts = yield* Drafts;
        const kept = drafts.state.get().get(key);
        assert.strictEqual(kept?.files.length, MAX_ATTACHMENTS_PER_MESSAGE + 1);
        assert.strictEqual(yield* drafts.send(target), "too-many-files");
        assert.deepStrictEqual(drafts.state.get().get(key), kept);
        assert.strictEqual((yield* unsent(device.storage)).length, 0);
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
    }),
  );

  it.effect("finds the draft changed when another tab sent one this tab never saw", () =>
    Effect.gen(function* () {
      const { sends } = yield* Taps;
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
          yield* whenStored(device.storage, "outbox", yield* Queue.take(sends), sent);
        }).pipe(
          Effect.scoped,
          // It closed before it told the other tab of anything.
          Effect.provide(client(first.credential, { ...device, window: device.unannounced })),
        );
        const noticed = yield* Stream.runHead(one.changedElsewhere).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* one.setText(target, "from one");

        assert.deepStrictEqual(
          yield* Fiber.join(noticed),
          Option.some({ target, whileSending: false, displaced: true }),
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
      const { sends } = yield* Taps;
      const drafts = yield* Drafts;
      const botId = yield* createBot("Careful");
      const target: EntryTarget = { _tag: "conversation", botId };
      const conversation = yield* (yield* Conversations).open(target);
      yield* waitFor(conversation.state, (state) => state.phase === "ready");

      yield* drafts.setText(target, "do not lose me");
      assert.strictEqual(yield* drafts.send(target), "not-kept");

      assert.deepStrictEqual(drafts.state.get().get(targetKey(target)), {
        text: "do not lose me",
        mentions: [],
        files: [],
        sending: false,
      });
      assert.isFalse(conversation.state.get().items.some((item) => item._tag === "outgoing"));
      assert.strictEqual(yield* Queue.size(sends), 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(client(Option.none(), TestPlatform.makeDevice({ refuseCommits: () => true }))),
    ),
  );

  it.effect("drops a message sent again once accepted, and shows its entry in the history", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Taps;
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
        yield* whenStored(device.storage, "outbox", commandId, sent);
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
        yield* whenStored(device.storage, "outbox", first.commandId, sent);
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
      const { gate, sends } = yield* Taps;
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
        // Attached with no place given, the file follows the text.
        assert.strictEqual(restored?.text, `notes attached${FILE_MARK}`);
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

  it.effect(
    "keeps each file of a draft where it was placed through a reload, and sends its place",
    () =>
      Effect.gen(function* () {
        const { sends } = yield* Taps;
        const device = TestPlatform.makeDevice();
        const upload = (name: string) => ({ name, body: new Blob([name], { type: "text/plain" }) });

        const first = yield* Effect.gen(function* () {
          yield* pairAndConnect;
          const botId = yield* createBot("Reader");
          const target: EntryTarget = { _tag: "conversation", botId };
          const key = targetKey(target);
          const drafts = yield* Drafts;
          yield* drafts.setText(target, "compare  with");
          yield* drafts.attach(target, [upload("a.txt")], 8);
          yield* drafts.attach(target, [upload("b.txt")]);
          // The first goes where the caret was; one given no place, after the text.
          yield* drafts.attach(target, [upload("c.txt")], 0);
          const ready = yield* waitFor(drafts.state, (state) => {
            const files = state.get(key)?.files ?? [];
            return files.length === 3 && files.every((file) => file._tag === "ready");
          });
          const ids = (ready.get(key)?.files ?? []).flatMap((file) =>
            file._tag === "ready" ? [file.attachment.id] : [],
          );
          yield* whenStored(device.storage, "drafts", key, (record) =>
            ids.every((id) => record?.includes(id) === true),
          );
          return { target, ids, credential: yield* savedCredential };
        }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));

        yield* Effect.gen(function* () {
          const drafts = yield* Drafts;
          const restored = drafts.state.get().get(targetKey(first.target));
          assert.strictEqual(restored?.text, `${FILE_MARK}compare ${FILE_MARK} with${FILE_MARK}`);
          assert.deepStrictEqual(
            restored?.files.map((file) => file._tag === "ready" && file.attachment.name),
            ["c.txt", "a.txt", "b.txt"],
          );

          assert.strictEqual(yield* drafts.send(first.target), "sent");
          const commandId = yield* Queue.take(sends);
          const conversation = yield* (yield* Conversations).open(first.target);
          const delivered = yield* waitFor(conversation.state, (state) =>
            state.items.some((item) => item._tag === "message" && item.commandId === commandId),
          );
          const message = delivered.items.find(
            (item) => item._tag === "message" && item.commandId === commandId,
          );
          if (message?._tag !== "message") return assert.fail("No message");
          assert.strictEqual(message.text, "compare  with");
          assert.deepStrictEqual(message.attachmentOffsets, [0, 8, 13]);
          assert.deepStrictEqual(
            message.attachments.map((attachment) => attachment.id),
            first.ids,
          );
        }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));
      }),
  );

  it.effect("places the files of a draft kept before drafts placed them after its text", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const target: EntryTarget = { _tag: "conversation", botId: BotId.make("reader") };
      const key = targetKey(target);
      const file = {
        id: AttachmentId.make("notes"),
        name: "notes.txt",
        mediaType: "text/plain",
        size: 5,
      };

      const credential = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const pairing = yield* (yield* Connection).deviceId;
        const older = JSON.stringify({ revision: "older", pairing, text: "notes", files: [file] });
        yield* device.storage.commit([{ table: "drafts", key, value: older }]).pipe(Effect.orDie);
        return yield* savedCredential;
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));

      yield* Effect.gen(function* () {
        const shown = (yield* Drafts).state.get().get(key);
        assert.strictEqual(shown?.text, `notes${FILE_MARK}`);
        assert.deepStrictEqual(
          shown?.files.map((one) => one.key),
          ["notes"],
        );
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("keeps the mentions picked in a draft through a reload", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const target: EntryTarget = { _tag: "room", roomId: RoomId.make("launch") };
      const key = targetKey(target);

      const first = yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const botId = yield* createBot("Ana Lima");
        const mentions = [
          { _tag: "bot", botId, label: "Ana Lima", position: 4 },
          { _tag: "everyone", position: 19 },
        ] as const;
        yield* (yield* Drafts).setText(target, "ask @Ana Lima, then @everyone", mentions);
        yield* whenStored(device.storage, "drafts", key, holds("Ana Lima"));
        return { mentions, credential: yield* savedCredential };
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));

      yield* Effect.gen(function* () {
        const drafts = yield* Drafts;
        assert.deepStrictEqual(drafts.state.get().get(key)?.mentions, first.mentions);
        // A draft kept before drafts held mentions reads as holding none.
        const pairing = yield* (yield* Connection).deviceId;
        const older = JSON.stringify({ revision: "older", pairing, text: "@Ana", files: [] });
        yield* device.storage.commit([{ table: "drafts", key, value: older }]).pipe(Effect.orDie);
      }).pipe(Effect.scoped, Effect.provide(client(first.credential, device)));

      yield* Effect.gen(function* () {
        const shown = (yield* Drafts).state.get().get(key);
        assert.strictEqual(shown?.text, "@Ana");
        assert.deepStrictEqual(shown?.mentions, []);
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
      yield* Queue.take((yield* Taps).sends);
    }).pipe(Effect.scoped, Effect.provide(client())),
  );
  it.effect("shows a message another tab could not deliver as not sent", () =>
    Effect.gen(function* () {
      const { sends, refusing } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Gone");
      refusing.add("for a bot that is gone");

      yield* Effect.gen(function* () {
        yield* goOffline;
        const one = yield* Conversations;
        const conversation = yield* one.open(target);
        yield* one.enqueue({ target, text: "for a bot that is gone" });
        const [kept] = outgoingIn(conversation.state.get());
        if (kept === undefined) return assert.fail("No outgoing message");

        // A connected tab delivers it, and the server refuses it.
        yield* Effect.gen(function* () {
          assert.strictEqual(yield* Queue.take(sends), kept.commandId);
          const refused = yield* waitFor(conversation.state, (state) =>
            outgoingIn(state).some((message) => message.status._tag === "not-sent"),
          );
          assert.deepStrictEqual(
            outgoingIn(refused).map((message) => messageStatus(message)),
            [
              {
                _tag: "not-sent",
                failure: { _tag: "refused", error: new NotFound({ resource: "bot" }) },
              },
            ],
          );
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("sends again a refused message with the mentions it is given in place of its own", () =>
    Effect.gen(function* () {
      const { sends, refusing } = yield* Taps;
      const { device, botId, credential } = yield* pairedDevice("Stays");
      const text = "@Stays and @Left, have a look";
      refusing.add(text);

      yield* Effect.gen(function* () {
        const conversations = yield* Conversations;
        const left = yield* createBot("Left");
        const target = yield* createRoom("Review", [botId, left]);
        const conversation = yield* conversations.open(target);
        yield* conversations.enqueue({
          target,
          text,
          mentions: { _tag: "bots", ids: [botId, left] },
        });
        const commandId = yield* Queue.take(sends);
        yield* waitFor(conversation.state, (state) =>
          outgoingIn(state).some((message) => message.status._tag === "not-sent"),
        );

        refusing.delete(text);
        const result = yield* conversations.resend(commandId, { _tag: "bots", ids: [botId] });
        assert.strictEqual(result._tag, "done");
        assert.strictEqual(yield* Queue.take(sends), commandId);
        const sent = yield* waitFor(conversation.state, (state) =>
          state.items.some((item) => item._tag === "message" && item.commandId === commandId),
        );
        const message = sent.items.find(
          (item) => item._tag === "message" && item.commandId === commandId,
        );
        assert.deepStrictEqual(message?._tag === "message" && message.mentions, {
          _tag: "bots",
          ids: [botId],
        });
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect(
    "keeps the name each mention was picked by with a message not sent, through a reload",
    () =>
      Effect.gen(function* () {
        const { sends, refusing } = yield* Taps;
        const { device, target, botId, credential } = yield* pairedDevice("Wren");
        const text = "@Wren, have a look";
        refusing.add(text);
        const notSent = (state: ConversationState) =>
          outgoingIn(state).find((message) => message.status._tag === "not-sent");

        yield* Effect.gen(function* () {
          const conversation = yield* (yield* Conversations).open(target);
          const drafts = yield* Drafts;
          yield* drafts.setText(target, text, [{ _tag: "bot", botId, label: "Wren", position: 0 }]);
          const addressing = {
            mentions: { _tag: "bots", ids: [botId] },
            labels: [{ botId, label: "Wren" }],
          } as const;
          assert.strictEqual(yield* drafts.send(target, addressing), "sent");
          yield* Queue.take(sends);
          yield* waitFor(conversation.state, (state) => notSent(state) !== undefined);
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));

        yield* Effect.gen(function* () {
          const conversation = yield* (yield* Conversations).open(target);
          const state = yield* waitFor(conversation.state, (shown) => notSent(shown) !== undefined);
          assert.deepStrictEqual(notSent(state)?.labels, [{ botId, label: "Wren" }]);
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }),
  );

  it.effect("does nothing when Retry finds the message discarded in another tab", () =>
    Effect.gen(function* () {
      const { sends, refusing } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Refuser");
      refusing.add("refused, then discarded");
      const notSent = (state: ConversationState) =>
        outgoingIn(state).some((message) => message.status._tag === "not-sent");

      yield* Effect.gen(function* () {
        const one = yield* Conversations;
        const conversation = yield* one.open(target);
        yield* one.enqueue({ target, text: "refused, then discarded" });
        const commandId = yield* Queue.take(sends);
        yield* waitFor(conversation.state, notSent);

        yield* Effect.gen(function* () {
          const two = yield* Conversations;
          yield* waitFor((yield* two.open(target)).state, notSent);
          yield* two.discard(commandId);
          // The first tab's Retry comes before it reads the outbox again.
          assert.deepStrictEqual(yield* one.resend(commandId), {
            _tag: "failed",
            failure: { _tag: "unexpected" },
          });
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));

        const again = yield* Queue.take(sends).pipe(Effect.timeoutOption("200 millis"));
        assert.isTrue(Option.isNone(again));
        assert.deepStrictEqual(yield* unsent(device.storage), []);
        yield* waitFor(conversation.state, (state) => outgoingIn(state).length === 0);
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("sends from a connected tab what a tab was sending when it went offline", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Handoff");

      yield* gate.close;
      yield* Effect.gen(function* () {
        yield* (yield* Conversations).enqueue({ target, text: "half way" });
        const commandId = yield* Queue.take(sends);
        // The server holds the message as the network goes.
        yield* goOffline;

        yield* Effect.gen(function* () {
          yield* waitFor((yield* Connection).state, isConnected);
          const resent = yield* Queue.take(sends).pipe(Effect.timeoutOption("2 seconds"));
          assert.deepStrictEqual(resent, Option.some(commandId));
          yield* gate.open;
          yield* whenStored(device.storage, "outbox", commandId, sent);
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(gate.open),
        Effect.provide(client(credential, device)),
      );
    }),
  );

  it.effect("settles a send another tab delivered, and does not send it again", () =>
    Effect.gen(function* () {
      const { sends, applied } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Proxy");

      yield* Effect.gen(function* () {
        yield* goOffline;
        const one = yield* Conversations;
        const sending = yield* Effect.forkChild(one.send({ target, text: "through a peer" }), {
          startImmediately: true,
        });

        // A connected tab delivers it while this one is offline.
        const commandId = yield* Effect.gen(function* () {
          const delivered = yield* Queue.take(sends);
          yield* whenStored(device.storage, "outbox", delivered, sent);
          return delivered;
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
        const entryId = applied.get(commandId);
        if (entryId === undefined) return assert.fail("The server did not apply it");
        assert.deepStrictEqual(yield* Fiber.join(sending), { _tag: "done", value: entryId });

        yield* (yield* TestPlatform.TestNetwork).set("online");
        yield* waitFor((yield* Connection).state, isConnected);
        const again = yield* Queue.take(sends).pipe(Effect.timeoutOption("300 millis"));
        assert.isTrue(Option.isNone(again));
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("sends a message whose tab closed before telling the others", () =>
    Effect.gen(function* () {
      const { sends } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Quiet");

      yield* Effect.gen(function* () {
        yield* waitFor((yield* Connection).state, isConnected);
        // Another tab, offline, keeps a message and closes without a word.
        const commandId = yield* Effect.gen(function* () {
          yield* goOffline;
          const conversations = yield* Conversations;
          const conversation = yield* conversations.open(target);
          yield* conversations.enqueue({ target, text: "said nothing" });
          return outgoingIn(conversation.state.get())[0]?.commandId;
        }).pipe(
          Effect.scoped,
          Effect.provide(client(credential, { ...device, window: device.unannounced })),
        );
        if (commandId === undefined) return assert.fail("No message kept");

        assert.strictEqual(yield* Queue.take(sends), commandId);
        yield* whenStored(device.storage, "outbox", commandId, sent);
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("sends messages kept in the same millisecond in the order they were kept", () =>
    Effect.gen(function* () {
      const { sends } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Hasty");
      const texts = ["one", "two", "three", "four", "five", "six"];

      yield* Effect.gen(function* () {
        const conversations = yield* Conversations;
        const conversation = yield* conversations.open(target);
        yield* goOffline;
        for (const text of texts) yield* conversations.enqueue({ target, text });

        yield* (yield* TestPlatform.TestNetwork).set("online");
        const delivered = yield* waitFor(
          conversation.state,
          (state) =>
            state.phase === "ready" &&
            outgoingIn(state).length === 0 &&
            state.items.filter((item) => item._tag === "message").length === texts.length,
        );
        const order = delivered.items.flatMap((item) =>
          item._tag === "message" ? [{ text: item.text, commandId: item.commandId }] : [],
        );
        assert.deepStrictEqual(
          order.map((item) => item.text),
          texts,
        );
        // Each went once, in that order.
        const received = yield* Effect.forEach(texts, () => Queue.take(sends));
        assert.deepStrictEqual(
          received,
          order.map((item) => item.commandId),
        );
      }).pipe(atOneInstant, Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("does nothing when Discard finds a later attempt refused the same way", () =>
    Effect.gen(function* () {
      const { sends, refusing } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Stubborn");
      refusing.add("refused twice");
      const notSent = (state: ConversationState) =>
        outgoingIn(state).some((message) => message.status._tag === "not-sent");

      yield* Effect.gen(function* () {
        const one = yield* Conversations;
        const conversation = yield* one.open(target);
        yield* one.enqueue({ target, text: "refused twice" });
        const commandId = yield* Queue.take(sends);
        yield* waitFor(conversation.state, notSent);
        // This tab reads the outbox no more: it is offline, and nobody tells it anything.
        yield* goOffline;

        // Another tab sends it again, and the server refuses it the same way.
        yield* Effect.gen(function* () {
          const two = yield* Conversations;
          yield* waitFor((yield* two.open(target)).state, notSent);
          assert.strictEqual((yield* two.resend(commandId))._tag, "failed");
        }).pipe(
          Effect.scoped,
          Effect.provide(client(credential, { ...device, window: device.unannounced })),
        );
        assert.strictEqual(yield* Queue.take(sends), commandId);

        // This tab's Discard is for the attempt it saw, which is over.
        yield* one.discard(commandId);
        assert.deepStrictEqual(yield* unsent(device.storage), [commandId]);
        assert.isTrue(notSent(conversation.state.get()));
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("answers a Retry from the outbox after it, not from a read made before", () =>
    Effect.gen(function* () {
      const { sends, refusing } = yield* Taps;
      const readGate = yield* Latch.make(true);
      const reading = yield* Queue.unbounded<void>();
      const { device, target, credential } = yield* pairedDevice("Second chance", {
        readGate,
        reading,
      });
      refusing.add("refused, then taken");

      yield* Effect.gen(function* () {
        const conversations = yield* Conversations;
        const conversation = yield* conversations.open(target);
        yield* conversations.enqueue({ target, text: "refused, then taken" });
        const commandId = yield* Queue.take(sends);
        yield* waitFor(conversation.state, (state) =>
          outgoingIn(state).some((message) => message.status._tag === "not-sent"),
        );
        refusing.delete("refused, then taken");

        // A read of the outbox has found it refused, and is held before this tab follows it.
        yield* readGate.close;
        yield* Queue.take(reading);
        const retrying = yield* conversations
          .resend(commandId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* readGate.open;

        assert.strictEqual((yield* Fiber.join(retrying))._tag, "done");
        assert.strictEqual(yield* Queue.take(sends), commandId);
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("records an answer the device could not record, and never sends it again", () => {
    let full = false;
    return Effect.gen(function* () {
      const { gate, sends, refusing } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Full disk", {
        refuseCommits: () => full,
      });
      refusing.add("refused while the disk was full");

      yield* Effect.gen(function* () {
        const conversations = yield* Conversations;
        const conversation = yield* conversations.open(target);
        yield* gate.close;
        yield* conversations.enqueue({ target, text: "refused while the disk was full" });
        const commandId = yield* Queue.take(sends);
        // The device fills up while the server holds the message.
        full = true;
        yield* gate.open;

        const shown = yield* waitFor(conversation.state, (state) =>
          outgoingIn(state).some((message) => message.status._tag === "unrecorded"),
        );
        assert.deepStrictEqual(
          outgoingIn(shown).map((message) => messageStatus(message)),
          [{ _tag: "unrecorded" }],
        );
        // Sweeps go by, and none sends it again.
        const again = yield* Queue.take(sends).pipe(Effect.timeoutOption("400 millis"));
        assert.isTrue(Option.isNone(again));

        full = false;
        const recorded = yield* waitFor(conversation.state, (state) =>
          outgoingIn(state).some((message) => message.status._tag === "not-sent"),
        );
        assert.deepStrictEqual(
          outgoingIn(recorded).map((message) => messageStatus(message)),
          [
            {
              _tag: "not-sent",
              failure: { _tag: "refused", error: new NotFound({ resource: "bot" }) },
            },
          ],
        );
        assert.deepStrictEqual(yield* unsent(device.storage), [commandId]);
        assert.strictEqual(yield* Queue.size(sends), 0);
      }).pipe(
        Effect.scoped,
        Effect.ensuring(gate.open),
        Effect.provide(client(credential, device)),
      );
    });
  });

  it.effect("shows a refusal recorded offline once the outbox can be read again", () => {
    let full = false;
    // The read after the answer is recorded fails once.
    let failNextRead = false;
    let armed = false;
    return Effect.gen(function* () {
      const { gate, sends, refusing } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Flaky disk", {
        refuseCommits: () => {
          if (full) return true;
          if (armed) {
            armed = false;
            failNextRead = true;
          }
          return false;
        },
        refuseReads: () => {
          if (!failNextRead) return false;
          failNextRead = false;
          return true;
        },
      });
      refusing.add("refused, recorded offline");

      yield* Effect.gen(function* () {
        const conversations = yield* Conversations;
        const conversation = yield* conversations.open(target);
        yield* gate.close;
        yield* conversations.enqueue({ target, text: "refused, recorded offline" });
        yield* Queue.take(sends);
        full = true;
        yield* gate.open;
        yield* waitFor(conversation.state, (state) =>
          outgoingIn(state).some((message) => message.status._tag === "unrecorded"),
        );

        // Offline, nothing reads the outbox again but this window's own retries.
        yield* goOffline;
        armed = true;
        full = false;
        const recorded = yield* waitFor(conversation.state, (state) =>
          outgoingIn(state).some((message) => message.status._tag === "not-sent"),
        );
        assert.deepStrictEqual(
          outgoingIn(recorded).map((message) => messageStatus(message)._tag),
          ["not-sent"],
        );
      }).pipe(
        Effect.scoped,
        Effect.ensuring(gate.open),
        Effect.provide(client(credential, device)),
      );
    });
  });

  it.effect("drops a message another tab delivered once the history loaded starts after it", () =>
    Effect.gen(function* () {
      const { sends } = yield* Taps;
      const { device, target, botId, credential } = yield* pairedDevice("Busy");

      yield* Effect.gen(function* () {
        yield* goOffline;
        const one = yield* Conversations;
        const conversation = yield* one.open(target);
        yield* one.enqueue({ target, text: "delivered next door" });

        // A connected tab delivers it, and this one learns that the server has it.
        const commandId = yield* Effect.gen(function* () {
          const delivered = yield* Queue.take(sends);
          yield* whenStored(device.storage, "outbox", delivered, sent);
          return delivered;
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
        yield* waitFor(conversation.state, (state) =>
          outgoingIn(state).some((message) => message.status._tag === "accepted"),
        );
        // More than a snapshot's worth of entries comes after it.
        for (let index = 0; index < 101; index++) yield* botSays(botId, `reply ${index}`);

        yield* (yield* TestPlatform.TestNetwork).set("online");
        const settled = yield* waitFor(
          conversation.state,
          (state) => state.phase === "ready" && outgoingIn(state).length === 0,
        );
        assert.isTrue(settled.hasOlder);
        assert.isFalse(
          settled.items.some((item) => item._tag === "message" && item.commandId === commandId),
        );
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("drops it too when this tab learns of the delivery only once it reconnects", () =>
    Effect.gen(function* () {
      const { sends } = yield* Taps;
      const { device, target, botId, credential } = yield* pairedDevice("Busier");

      yield* Effect.gen(function* () {
        yield* goOffline;
        const one = yield* Conversations;
        const conversation = yield* one.open(target);
        yield* one.enqueue({ target, text: "delivered without a word" });

        // A connected tab that tells nobody delivers it.
        yield* Effect.gen(function* () {
          const delivered = yield* Queue.take(sends);
          yield* whenStored(device.storage, "outbox", delivered, sent);
        }).pipe(
          Effect.scoped,
          Effect.provide(client(credential, { ...device, window: device.unannounced })),
        );
        assert.deepStrictEqual(
          outgoingIn(conversation.state.get()).map((message) => message.status._tag),
          ["sending"],
        );
        for (let index = 0; index < 101; index++) yield* botSays(botId, `later ${index}`);

        yield* (yield* TestPlatform.TestNetwork).set("online");
        const settled = yield* waitFor(
          conversation.state,
          (state) => state.phase === "ready" && outgoingIn(state).length === 0,
        );
        assert.isTrue(settled.hasOlder);
        assert.strictEqual(yield* Queue.size(sends), 0);
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("keeps, and does not send, a draft whose images together are over the limit", () =>
    Effect.gen(function* () {
      const { sends } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Gallery");
      const key = targetKey(target);
      // As many of the largest images as a message's images may add up to, and one more,
      // kept as a draft can be when another tab changed it.
      const images = Array.from(
        { length: Math.floor(MAX_INLINE_IMAGES_SIZE / MAX_INLINE_IMAGE_SIZE) + 1 },
        (_, index) => ({
          id: `image-${index}`,
          name: `image-${index}.png`,
          mediaType: "image/png",
          size: MAX_INLINE_IMAGE_SIZE,
        }),
      );
      assert.isAtMost(images.length, MAX_ATTACHMENTS_PER_MESSAGE);
      yield* device.storage
        .write(
          "drafts",
          key,
          JSON.stringify({
            revision: "earlier",
            pairing: Option.getOrThrow(credential).deviceId,
            text: "",
            files: images,
          }),
        )
        .pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        const drafts = yield* Drafts;
        const kept = drafts.state.get().get(key);
        assert.strictEqual(yield* drafts.send(target), "images-too-large");
        assert.deepStrictEqual(drafts.state.get().get(key), kept);

        const ready = (kept?.files ?? []).flatMap((file) =>
          file._tag === "ready" ? [file.attachment] : [],
        );
        const refused = yield* (yield* Conversations)
          .send({ target, text: "", attachments: ready })
          .pipe(Effect.flip);
        assert.strictEqual(refused.problem, "images-too-large");

        assert.deepStrictEqual(yield* unsent(device.storage), []);
        assert.strictEqual(yield* Queue.size(sends), 0);
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("keeps a newer pairing when a tab learns late that the old one ended", () =>
    Effect.gen(function* () {
      const { device, target, credential } = yield* pairedDevice("Paired twice");
      const key = targetKey(target);
      const tickets = yield* Latch.make(true);
      const heard = yield* Latch.make(false);

      // A slow tab: it runs other tabs' broadcasts late, and its next socket ticket waits.
      yield* Effect.gen(function* () {
        const slow = yield* Connection;
        const slowDrafts = yield* Drafts;
        yield* waitFor(slow.state, isConnected);
        yield* tickets.close;

        yield* Effect.gen(function* () {
          const connection = yield* Connection;
          yield* waitFor(connection.state, isConnected);
          // This tab signs out, which closes the slow tab's socket, pairs again, and writes.
          assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "signed-out" });
          yield* pairAndConnect;
          const paired = Option.map(yield* savedCredential, (stored) => stored.deviceId);
          yield* (yield* Drafts).setText(target, "written after pairing again");
          yield* whenStored(device.storage, "drafts", key, holds("written after pairing again"));

          // Only now is the slow tab refused, for the pairing that ended.
          yield* tickets.open;
          const settled = yield* waitFor(
            slow.state,
            (state) => isConnected(state) || state._tag === "unpaired",
          );
          assert.strictEqual(settled._tag, "connected");
          yield* waitFor(
            slowDrafts.state,
            (drafts) => drafts.get(key)?.text === "written after pairing again",
          );
          assert.deepStrictEqual(
            Option.map(yield* savedCredential, (stored) => stored.deviceId),
            paired,
          );
          assert.isTrue(isConnected(connection.state.get()));
          yield* whenStored(device.storage, "drafts", key, holds("written after pairing again"));
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(Effect.andThen(tickets.open, heard.open)),
        Effect.provide(
          client(
            credential,
            { ...device, credentials: () => device.credentials(heard) },
            heldAt(HTTP_PATHS.socketTicket, tickets),
          ),
        ),
      );
    }),
  );

  it.effect("keeps a pairing made while a tab signs out, with what it wrote", () =>
    Effect.gen(function* () {
      const { device, target, credential } = yield* pairedDevice("Signed out under");
      const key = targetKey(target);
      const tickets = yield* Latch.make(true);
      const heard = yield* Latch.make(false);

      // The tab that signs out: it hears other tabs late, its next socket
      // ticket waits, and the server's answer to its revocation is lost.
      yield* Effect.gen(function* () {
        const leaving = yield* Connection;
        const leavingDrafts = yield* Drafts;
        const network = yield* TestPlatform.TestNetwork;
        const signOut = yield* SignOut;
        yield* waitFor(leaving.state, isConnected);

        yield* Effect.gen(function* () {
          const connection = yield* Connection;
          yield* waitFor(connection.state, isConnected);
          yield* tickets.close;
          yield* network.loseReplies(true);
          const signingOut = yield* signOut.run.pipe(Effect.forkChild({ startImmediately: true }));

          // The revocation reaches this tab first, which pairs again and writes.
          yield* waitFor(connection.state, (state) => state._tag === "unpaired");
          yield* pairAndConnect;
          const paired = yield* savedCredential;
          if (Option.isNone(paired)) return assert.fail("The new pairing was not saved");
          yield* (yield* Drafts).setText(target, "written after pairing again");
          yield* whenStored(device.storage, "drafts", key, holds("written after pairing again"));

          // The tab signing out follows the new pairing before its revocation is answered.
          yield* heard.open;
          yield* waitFor(leaving.pairing, (pairing) => pairing === paired.value.deviceId);
          yield* network.loseReplies(false);
          yield* tickets.open;

          assert.strictEqual((yield* Fiber.join(signingOut))._tag, "paired-anew");
          assert.deepStrictEqual(
            Option.map(yield* savedCredential, (stored) => stored.deviceId),
            Option.some(paired.value.deviceId),
          );
          yield* whenStored(device.storage, "drafts", key, holds("written after pairing again"));
          yield* waitFor(
            leavingDrafts.state,
            (drafts) => drafts.get(key)?.text === "written after pairing again",
          );
          assert.isTrue(isConnected(connection.state.get()));
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(Effect.andThen(tickets.open, heard.open)),
        Effect.provide(
          client(
            credential,
            { ...device, credentials: () => device.credentials(heard) },
            heldAt(HTTP_PATHS.socketTicket, tickets),
          ),
        ),
      );
    }),
  );

  it.effect("erases at launch the drafts and messages a pairing that ended left behind", () =>
    Effect.gen(function* () {
      const { device, target, credential } = yield* pairedDevice("Left over");
      const key = targetKey(target);
      yield* Effect.gen(function* () {
        yield* goOffline;
        yield* (yield* Drafts).setText(target, "from a pairing that ended");
        yield* whenStored(device.storage, "drafts", key, present);
        yield* (yield* Conversations).enqueue({ target, text: "never to be sent" });
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      // The pairing ends, and the browser closes before its text is erased.
      if (Option.isNone(credential)) return assert.fail("The pairing was not saved");
      yield* device.credentials().clear(credential.value, "refused").pipe(Effect.orDie);

      yield* Effect.gen(function* () {
        assert.strictEqual((yield* Drafts).state.get().size, 0);
        assert.strictEqual((yield* device.storage.readAll("drafts").pipe(Effect.orDie)).size, 0);
        assert.strictEqual((yield* device.storage.readAll("outbox").pipe(Effect.orDie)).size, 0);
      }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
    }),
  );

  it.effect("takes no change to a draft while the drafts of a new pairing load", () =>
    Effect.gen(function* () {
      const readGate = yield* Latch.make(true);
      const { device, target, credential } = yield* pairedDevice("Switched", { readGate });
      const key = targetKey(target);
      const heard = yield* Latch.make(false);
      const tickets = yield* Latch.make(true);

      // A tab that hears of the new pairing only once it is made, and follows
      // it directly: its next socket ticket waits, so the server cannot
      // refuse the old pairing first.
      yield* Effect.gen(function* () {
        const drafts = yield* Drafts;
        yield* waitFor((yield* Connection).state, isConnected);
        yield* drafts.setText(target, "the old pairing's");
        yield* whenStored(device.storage, "drafts", key, holds("the old pairing's"));

        yield* Effect.gen(function* () {
          yield* waitFor((yield* Connection).state, isConnected);
          yield* tickets.close;
          assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "signed-out" });
          yield* pairAndConnect;
          yield* (yield* Drafts).setText(target, "the new pairing's");
          yield* whenStored(device.storage, "drafts", key, holds("the new pairing's"));

          yield* readGate.close;
          yield* heard.open;
          yield* waitFor(drafts.switching, (switching) => switching);
          yield* drafts.setText(target, "typed while it loads");
          assert.notStrictEqual(drafts.state.get().get(key)?.text, "typed while it loads");
          yield* readGate.open;

          yield* waitFor(drafts.switching, (switching) => !switching);
          assert.strictEqual(drafts.state.get().get(key)?.text, "the new pairing's");
          yield* whenStored(device.storage, "drafts", key, holds("the new pairing's"));
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(Effect.all([readGate.open, heard.open, tickets.open])),
        Effect.provide(
          client(
            credential,
            { ...device, credentials: () => device.credentials(heard) },
            heldAt(HTTP_PATHS.socketTicket, tickets),
          ),
        ),
      );
    }),
  );

  it.effect("keeps no message for a pairing this tab no longer follows", () => {
    const device = TestPlatform.makeDevice();
    return Effect.gen(function* () {
      yield* pairAndConnect;
      const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Moved on") };
      const failed = yield* (yield* Conversations)
        .enqueue(
          { target, text: "for the pairing before" },
          { pairing: DeviceId.make("a-pairing-that-ended"), alongside: [], expected: [] },
        )
        .pipe(Effect.flip);
      assert.strictEqual(failed._tag, "NotPaired");
      assert.deepStrictEqual(yield* unsent(device.storage), []);
    }).pipe(Effect.provide(client(Option.none(), device)));
  });

  it.effect("writes and sends nothing of a pairing a tab learns late has ended", () =>
    Effect.gen(function* () {
      const { device, target, credential } = yield* pairedDevice("Late to hear");
      const key = targetKey(target);
      const tickets = yield* Latch.make(true);
      const heard = yield* Latch.make(false);

      // A tab that runs other tabs' broadcasts late, and whose next socket ticket waits.
      yield* Effect.gen(function* () {
        const lateDrafts = yield* Drafts;
        const lateConversations = yield* Conversations;
        yield* waitFor((yield* Connection).state, isConnected);
        yield* tickets.close;

        yield* Effect.gen(function* () {
          const drafts = yield* Drafts;
          yield* waitFor((yield* Connection).state, isConnected);
          assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "signed-out" });
          yield* pairAndConnect;
          yield* drafts.setText(target, "the new pairing's");
          yield* whenStored(device.storage, "drafts", key, holds("the new pairing's"));

          // The late tab still follows the pairing that ended, and writes and sends under it.
          yield* lateDrafts.setText(target, "typed under the old pairing");
          assert.strictEqual(yield* lateDrafts.send(target), "not-kept");
          assert.deepStrictEqual(
            yield* lateConversations.send({ target, text: "sent under the old pairing" }),
            { _tag: "failed", failure: { _tag: "not-paired" } },
          );

          assert.deepStrictEqual(yield* unsent(device.storage), []);
          yield* whenStored(device.storage, "drafts", key, holds("the new pairing's"));
          assert.strictEqual(drafts.state.get().get(key)?.text, "the new pairing's");
          assert.strictEqual(drafts.offers.get().size, 0);

          // Once it hears, it follows the new pairing and shows its draft.
          yield* heard.open;
          yield* tickets.open;
          yield* waitFor(lateDrafts.state, (state) => state.get(key)?.text === "the new pairing's");
          assert.strictEqual(lateDrafts.offers.get().size, 0);
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(Effect.andThen(tickets.open, heard.open)),
        Effect.provide(
          client(
            credential,
            { ...device, credentials: () => device.credentials(heard) },
            heldAt(HTTP_PATHS.socketTicket, tickets),
          ),
        ),
      );
    }),
  );

  it.effect("shows and sends nothing of an ended pairing whose text could not be erased", () => {
    let full = false;
    const device = TestPlatform.makeDevice({ refuseCommits: () => full });
    return Effect.gen(function* () {
      const network = yield* TestPlatform.TestNetwork;
      const drafts = yield* Drafts;
      const conversations = yield* Conversations;
      yield* pairAndConnect;
      const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Not erased") };
      const key = targetKey(target);
      yield* goOffline;
      yield* drafts.setText(target, "the old pairing's draft");
      yield* whenStored(device.storage, "drafts", key, holds("the old pairing's draft"));
      yield* conversations.enqueue({ target, text: "the old pairing's message" });

      // The device refuses every write while this device signs out, so its text stays.
      full = true;
      assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "still-listed" });
      assert.strictEqual((yield* unsent(device.storage)).length, 1);
      full = false;

      yield* network.set("online");
      yield* pairAndConnect;
      yield* waitFor(drafts.switching, (switching) => !switching);
      assert.isUndefined(drafts.state.get().get(key));

      // Its own draft takes the place of the old one, with nothing offered back.
      yield* drafts.setText(target, "the new pairing's draft");
      yield* whenStored(device.storage, "drafts", key, holds("the new pairing's draft"));
      assert.strictEqual(drafts.offers.get().size, 0);

      // Its own message is the first and only one the server gets.
      const { sends } = yield* Taps;
      const conversation = yield* conversations.open(target);
      yield* conversations.enqueue({ target, text: "the new pairing's message" });
      const delivered = yield* Queue.take(sends);
      const shown = yield* waitFor(conversation.state, (state) =>
        state.items.some((item) => item._tag === "message" && item.commandId === delivered),
      );
      assert.deepStrictEqual(
        shown.items.flatMap((item) =>
          item._tag === "message" || item._tag === "outgoing" ? [item.text] : [],
        ),
        ["the new pairing's message"],
      );
      assert.strictEqual(yield* Queue.size(sends), 0);
    }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));
  });

  it.effect("signs out only its own pairing when another is made while an answer is recorded", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Taps;
      const commitGate = yield* Latch.make(true);
      const committing = yield* Queue.unbounded<void>();
      const { device, target, credential } = yield* pairedDevice("Recorded late", {
        commitGate,
        committing,
      });

      yield* Effect.gen(function* () {
        const leaving = yield* Connection;
        yield* waitFor(leaving.state, isConnected);
        yield* gate.close;
        yield* (yield* Conversations).enqueue({ target, text: "answered while signing out" });
        yield* Queue.take(sends);

        // The device holds the transaction that records the server's answer.
        yield* commitGate.close;
        yield* Queue.clear(committing);
        yield* gate.open;
        yield* Queue.take(committing);
        const signingOut = yield* (yield* SignOut).run.pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        // Meanwhile another tab pairs anew, and this one follows it.
        yield* Effect.gen(function* () {
          const connection = yield* Connection;
          yield* waitFor(connection.state, isConnected);
          yield* pairAndConnect;
          const paired = yield* savedCredential;
          if (Option.isNone(paired)) return assert.fail("The new pairing was not saved");
          yield* waitFor(leaving.pairing, (pairing) => pairing === paired.value.deviceId);
          yield* commitGate.open;

          assert.strictEqual((yield* Fiber.join(signingOut))._tag, "paired-anew");
          assert.deepStrictEqual(
            Option.map(yield* savedCredential, (stored) => stored.deviceId),
            Option.some(paired.value.deviceId),
          );
          // The new pairing still works.
          const drafts = yield* Drafts;
          yield* drafts.setText(target, "after the other tab signed out");
          yield* whenStored(
            device.storage,
            "drafts",
            targetKey(target),
            holds("after the other tab signed out"),
          );
          assert.isTrue(isConnected(connection.state.get()));
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(Effect.andThen(gate.open, commitGate.open)),
        Effect.provide(client(credential, device)),
      );
    }),
  );

  it.effect("shows nothing of the pairing it leaves while that pairing still saves", () =>
    Effect.gen(function* () {
      const { gate, sends } = yield* Taps;
      const commitGate = yield* Latch.make(true);
      const committing = yield* Queue.unbounded<void>();
      const { device, target, credential } = yield* pairedDevice("Left at once", {
        commitGate,
        committing,
      });
      const key = targetKey(target);

      yield* Effect.gen(function* () {
        const leaving = yield* Connection;
        const conversations = yield* Conversations;
        const drafts = yield* Drafts;
        yield* waitFor(leaving.state, isConnected);
        const conversation = yield* conversations.open(target);
        yield* gate.close;
        yield* conversations.enqueue({ target, text: "delivered under the old pairing" });
        yield* Queue.take(sends);
        yield* conversations.enqueue({ target, text: "waiting under the old pairing" });

        // The device holds the transaction that records the first message's
        // answer, then the one that saves the draft, which holds the drafts' lock.
        yield* commitGate.close;
        yield* Queue.clear(committing);
        yield* gate.open;
        yield* Queue.take(committing);
        yield* drafts.setText(target, "written under the old pairing");
        yield* Queue.take(committing);
        assert.isTrue(
          outgoingIn(conversation.state.get()).some(
            (message) => message.text === "waiting under the old pairing",
          ),
        );

        // Another tab pairs anew, and this one follows it.
        yield* Effect.gen(function* () {
          yield* waitFor((yield* Connection).state, isConnected);
          yield* pairAndConnect;
          const paired = yield* savedCredential;
          if (Option.isNone(paired)) return assert.fail("The new pairing was not saved");
          yield* waitFor(leaving.pairing, (pairing) => pairing === paired.value.deviceId);

          // The old pairing's text is still being saved, and none of it shows.
          assert.isTrue(drafts.switching.get());
          assert.deepStrictEqual(outgoingIn(conversation.state.get()), []);
          assert.strictEqual(drafts.state.get().get(key), undefined);
          yield* commitGate.open;
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(Effect.andThen(gate.open, commitGate.open)),
        Effect.provide(client(credential, device)),
      );
    }),
  );

  it.effect("finds a pairing another tab made while this one signed out, before word of it", () =>
    Effect.gen(function* () {
      const commitGate = yield* Latch.make(true);
      const { device, target, credential } = yield* pairedDevice("Paired before word", {
        commitGate,
      });
      const heard = yield* Latch.make(false);

      // The tab that signs out hears other tabs late.
      yield* Effect.gen(function* () {
        const leaving = yield* Connection;
        const signOut = yield* SignOut;
        yield* waitFor(leaving.state, isConnected);
        // A draft of the pairing that ends: signing out waits while it is erased.
        yield* (yield* Drafts).setText(target, "erased on sign-out");
        yield* whenStored(device.storage, "drafts", targetKey(target), holds("erased on sign-out"));

        yield* Effect.gen(function* () {
          const other = yield* Connection;
          yield* waitFor(other.state, isConnected);
          yield* commitGate.close;
          const signingOut = yield* signOut.run.pipe(Effect.forkChild({ startImmediately: true }));

          // The server ends the pairing, and both tabs let go of it.
          yield* waitFor(leaving.state, (state) => state._tag === "unpaired");
          yield* waitFor(other.state, (state) => state._tag === "unpaired");
          // The other tab pairs anew before the tab signing out hears of it.
          yield* pairAndConnect;
          const paired = yield* savedCredential;
          if (Option.isNone(paired)) return assert.fail("The new pairing was not saved");
          yield* commitGate.open;

          assert.deepStrictEqual(yield* Fiber.join(signingOut), {
            _tag: "paired-anew",
            revoked: true,
          });
          assert.strictEqual(leaving.pairing.get(), paired.value.deviceId);
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }).pipe(
        Effect.scoped,
        Effect.ensuring(Effect.andThen(commitGate.open, heard.open)),
        Effect.provide(
          client(credential, { ...device, credentials: () => device.credentials(heard) }),
        ),
      );
    }),
  );

  it.effect("takes no change to drafts it could not read, and shows them once read again", () =>
    Effect.gen(function* () {
      let refusing = false;
      const { device, target, credential } = yield* pairedDevice("Unread", {
        refuseReads: () => refusing,
      });
      const key = targetKey(target);
      yield* Effect.gen(function* () {
        yield* (yield* Drafts).setText(target, "kept before the failure");
        yield* whenStored(device.storage, "drafts", key, holds("kept before the failure"));
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));

      refusing = true;
      yield* Effect.gen(function* () {
        const drafts = yield* Drafts;
        assert.isTrue(drafts.readFailed.get());
        yield* drafts.setText(target, "typed over what could not be read");
        assert.strictEqual(drafts.state.get().get(key), undefined);

        assert.isFalse(yield* drafts.retryRead);
        refusing = false;
        assert.isTrue(yield* drafts.retryRead);
        assert.isFalse(drafts.readFailed.get());
        assert.strictEqual(drafts.state.get().get(key)?.text, "kept before the failure");
        yield* whenStored(device.storage, "drafts", key, holds("kept before the failure"));
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect(
    "saves a draft again until the device keeps it, and says meanwhile it is not saved",
    () =>
      Effect.gen(function* () {
        let refusing = false;
        const { device, target, credential } = yield* pairedDevice("Unsaved", {
          refuseCommits: () => refusing,
        });
        const key = targetKey(target);
        yield* Effect.gen(function* () {
          const drafts = yield* Drafts;
          refusing = true;
          yield* drafts.setText(target, "held until the device keeps it");
          yield* waitFor(drafts.notSaved, (keys) => keys.has(key));

          refusing = false;
          yield* whenStored(device.storage, "drafts", key, holds("held until the device keeps it"));
          yield* waitFor(drafts.notSaved, (keys) => !keys.has(key));
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));

        yield* Effect.gen(function* () {
          const shown = (yield* Drafts).state.get().get(key);
          assert.strictEqual(shown?.text, "held until the device keeps it");
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
      }),
  );

  it.effect("holds its text when another tab's change cannot be read, and sends nothing", () =>
    Effect.gen(function* () {
      let refusing = false;
      const { device, target, credential } = yield* pairedDevice("Unreadable change", {
        refuseReads: (table) => refusing && table === "drafts",
      });
      const key = targetKey(target);
      yield* Effect.gen(function* () {
        const drafts = yield* Drafts;
        yield* drafts.setText(target, "written in this tab");
        yield* whenStored(device.storage, "drafts", key, holds("written in this tab"));
        yield* Effect.gen(function* () {
          yield* (yield* Drafts).setText(target, "written in another tab");
          yield* whenStored(device.storage, "drafts", key, holds("written in another tab"));
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));

        refusing = true;
        yield* drafts.setText(target, "written here since");
        yield* waitFor(drafts.notSaved, (keys) => keys.has(key));
        assert.strictEqual(yield* drafts.send(target), "not-kept");
        assert.strictEqual(drafts.state.get().get(key)?.text, "written here since");
        assert.deepStrictEqual(yield* unsent(device.storage), []);

        // Read again, it shows the other tab's text and offers this one's back.
        refusing = false;
        yield* waitFor(drafts.state, (state) => state.get(key)?.text === "written in another tab");
        assert.isTrue(drafts.offers.get().has(key));
        assert.isFalse(drafts.notSaved.get().has(key));
        yield* drafts.restore(target);
        yield* whenStored(device.storage, "drafts", key, holds("written here since"));
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("uploads a file only for the pairing that took it", () =>
    Effect.gen(function* () {
      const commitGate = yield* Latch.make(true);
      const committing = yield* Queue.unbounded<void>();
      const { device, target, credential } = yield* pairedDevice("Uploads", {
        commitGate,
        committing,
      });
      const uploadGate = yield* Latch.make(false);
      const bearers: Array<string> = [];

      yield* Effect.gen(function* () {
        const connection = yield* Connection;
        const drafts = yield* Drafts;
        yield* waitFor(connection.state, isConnected);
        yield* drafts.attach(target, [
          {
            name: "old.txt",
            body: new Blob(["from the pairing that ends"], { type: "text/plain" }),
          },
        ]);
        // A save of another draft holds this tab's drafts, so they wait to drop the file.
        yield* commitGate.close;
        yield* drafts.setText({ _tag: "conversation", botId: yield* createBot("Busy") }, "saving");
        yield* Queue.take(committing);

        // Another tab signs out and pairs again; this tab follows.
        const paired = yield* Effect.gen(function* () {
          yield* waitFor((yield* Connection).state, isConnected);
          assert.strictEqual((yield* (yield* SignOut).run)._tag, "signed-out");
          yield* pairAndConnect;
          return yield* savedCredential;
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
        if (Option.isNone(paired)) return assert.fail("The new pairing was not saved");
        yield* waitFor(connection.pairing, (pairing) => pairing === paired.value.deviceId);
        yield* waitFor(connection.state, isConnected);

        // The first attempt fails now; nothing goes again, under any pairing.
        yield* uploadGate.open;
        yield* Effect.sleep("200 millis");
        assert.notInclude(bearers, `Bearer ${Redacted.value(paired.value.token)}`);
      }).pipe(
        Effect.scoped,
        Effect.ensuring(Effect.andThen(commitGate.open, uploadGate.open)),
        Effect.provide(client(credential, device, uploadsFailingOnce(uploadGate, bearers))),
      );
    }),
  );

  it.effect("does not claim the server ended access when another tab only signed out here", () =>
    Effect.gen(function* () {
      const { device, credential } = yield* pairedDevice("Signed out twice");
      if (Option.isNone(credential)) return assert.fail("The pairing was not saved");

      yield* Effect.gen(function* () {
        const leaving = yield* Connection;
        const lossy = yield* TestPlatform.TestNetwork;
        yield* waitFor(leaving.state, isConnected);
        // The revocation never reaches the server.
        yield* lossy.loseRequests(true);
        const signingOut = yield* (yield* SignOut).run.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* lossy.requestLost;

        // Another tab, offline, signs out here only.
        yield* Effect.gen(function* () {
          yield* goOffline;
          assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "still-listed" });
        }).pipe(Effect.scoped, Effect.provide(client(credential, device)));

        assert.deepStrictEqual(yield* Fiber.join(signingOut), { _tag: "still-listed" });
        const listed = yield* (yield* Server.Devices).list(credential.value.deviceId);
        assert.isTrue(listed.some((listedDevice) => listedDevice.id === credential.value.deviceId));
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect("finds the refusal another tab recorded while this one was not connected", () =>
    Effect.gen(function* () {
      const { device, credential } = yield* pairedDevice("Refused elsewhere");
      if (Option.isNone(credential)) return assert.fail("The pairing was not saved");
      const heard = yield* Latch.make(false);

      // The tab that signs out hears other tabs late, and is not connected.
      yield* Effect.gen(function* () {
        const leaving = yield* Connection;
        yield* waitFor(leaving.state, isConnected);
        yield* goOffline;
        // Another tab hears the server refuse the pairing, and records it.
        yield* device.credentials().clear(credential.value, "refused").pipe(Effect.orDie);
        assert.strictEqual(leaving.pairing.get(), credential.value.deviceId);

        assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "signed-out" });
      }).pipe(
        Effect.scoped,
        Effect.ensuring(heard.open),
        Effect.provide(
          client(credential, { ...device, credentials: () => device.credentials(heard) }),
        ),
      );
    }),
  );

  it.effect("tells what became of a fresh start the server fails", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const botId = yield* createBot("Not fresh");
      (yield* Taps).failingFreshStarts.count = 1;
      assert.deepStrictEqual(yield* (yield* Details).freshStart(botId), {
        _tag: "failed",
        failure: { _tag: "unexpected" },
      });
    }).pipe(Effect.provide(client())),
  );

  it.effect("shows the drafts already saved when a tab on the pairing screen is paired", () =>
    Effect.gen(function* () {
      const device = TestPlatform.makeDevice();
      const heard = yield* Latch.make(false);
      yield* Effect.gen(function* () {
        const waiting = yield* Connection;
        const waitingDrafts = yield* Drafts;
        yield* waitFor(waiting.state, (state) => state._tag === "unpaired");

        // Another tab pairs and writes a draft before this one hears.
        const target = yield* Effect.gen(function* () {
          yield* pairAndConnect;
          const botId = yield* createBot("Saved first");
          const written: EntryTarget = { _tag: "conversation", botId };
          yield* (yield* Drafts).setText(written, "saved before this tab was paired");
          yield* whenStored(
            device.storage,
            "drafts",
            targetKey(written),
            holds("saved before this tab was paired"),
          );
          return written;
        }).pipe(Effect.scoped, Effect.provide(client(Option.none(), device)));

        // Only now does this tab hear of the pairing.
        yield* heard.open;
        yield* waitFor(
          waitingDrafts.state,
          (state) => state.get(targetKey(target))?.text === "saved before this tab was paired",
        );
      }).pipe(
        Effect.scoped,
        Effect.ensuring(heard.open),
        Effect.provide(
          client(Option.none(), { ...device, credentials: () => device.credentials(heard) }),
        ),
      );
    }),
  );

  it.effect("answers Send again with what became of its own attempt, not of a later one", () =>
    Effect.gen(function* () {
      const { sends, refusing } = yield* Taps;
      const { device, target, credential } = yield* pairedDevice("Superseded");
      refusing.add("refused, then sent again");
      const notSent = (state: ConversationState) =>
        outgoingIn(state).some((message) => message.status._tag === "not-sent");

      yield* Effect.gen(function* () {
        const one = yield* Conversations;
        const conversation = yield* one.open(target);
        yield* one.enqueue({ target, text: "refused, then sent again" });
        const commandId = yield* Queue.take(sends);
        yield* waitFor(conversation.state, notSent);

        // This tab sends it again offline, and hears nothing more for a while.
        yield* goOffline;
        const retrying = yield* one
          .resend(commandId)
          .pipe(Effect.forkChild({ startImmediately: true }));

        // A tab that tells nobody delivers that attempt, which the server refuses,
        // then sends it again, and that attempt goes.
        yield* Effect.gen(function* () {
          const two = yield* Conversations;
          assert.strictEqual(yield* Queue.take(sends), commandId);
          yield* waitFor((yield* two.open(target)).state, notSent);
          refusing.delete("refused, then sent again");
          assert.strictEqual((yield* two.resend(commandId))._tag, "done");
        }).pipe(
          Effect.scoped,
          Effect.provide(client(credential, { ...device, window: device.unannounced })),
        );
        assert.strictEqual(yield* Queue.take(sends), commandId);

        yield* (yield* TestPlatform.TestNetwork).set("online");
        assert.deepStrictEqual(yield* Fiber.join(retrying), {
          _tag: "failed",
          failure: { _tag: "refused", error: new NotFound({ resource: "bot" }) },
        });
      }).pipe(Effect.scoped, Effect.provide(client(credential, device)));
    }),
  );

  it.effect(
    "shows a refusal it could not record as the socket closed, and records it offline",
    () => {
      let full = false;
      return Effect.gen(function* () {
        const { gate, sends, refusing } = yield* Taps;
        const commitGate = yield* Latch.make(true);
        const committing = yield* Queue.unbounded<void>();
        const { device, target, credential } = yield* pairedDevice("Cut off", {
          refuseCommits: () => full,
          commitGate,
          committing,
        });
        refusing.add("refused as the socket closed");
        const statusOf = (state: ConversationState) =>
          outgoingIn(state).map((message) => messageStatus(message));

        yield* Effect.gen(function* () {
          const conversations = yield* Conversations;
          const conversation = yield* conversations.open(target);
          yield* gate.close;
          yield* conversations.enqueue({ target, text: "refused as the socket closed" });
          const commandId = yield* Queue.take(sends);

          // The refusal reaches a full device, and the network goes while it tries to record it.
          yield* commitGate.close;
          yield* Queue.clear(committing);
          full = true;
          yield* gate.open;
          yield* Queue.take(committing);
          yield* goOffline;
          yield* commitGate.open;

          const shown = yield* waitFor(conversation.state, (state) =>
            statusOf(state).some((status) => status._tag === "unrecorded"),
          ).pipe(Effect.timeout("2 seconds"));
          assert.deepStrictEqual(statusOf(shown), [{ _tag: "unrecorded" }]);

          // Still offline, it is recorded once the device has room.
          full = false;
          const recorded = yield* waitFor(conversation.state, (state) =>
            statusOf(state).some((status) => status._tag === "not-sent"),
          ).pipe(Effect.timeout("2 seconds"));
          assert.deepStrictEqual(statusOf(recorded), [
            {
              _tag: "not-sent",
              failure: { _tag: "refused", error: new NotFound({ resource: "bot" }) },
            },
          ]);
          assert.strictEqual((yield* Connection).state.get()._tag, "offline");
          assert.deepStrictEqual(yield* unsent(device.storage), [commandId]);
          assert.strictEqual(yield* Queue.size(sends), 0);
        }).pipe(
          Effect.scoped,
          Effect.ensuring(Effect.andThen(gate.open, commitGate.open)),
          Effect.provide(client(credential, device)),
        );
      });
    },
  );

  it.effect("shows the settings the server holds after a save whose answer was lost", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const settings = yield* Settings;
      const network = yield* TestPlatform.TestNetwork;
      const loaded = yield* waitFor(settings.state, (state) => state._tag === "ready");
      if (loaded._tag !== "ready") return assert.fail("No settings");
      const before = loaded.value.notifications.previews;

      yield* network.loseReplies(true);
      const saving = yield* Effect.forkChild(
        settings.update({ section: "notifications", changes: { previews: !before } }),
        { startImmediately: true },
      );

      // Another device sees the save arrive, then changes it back.
      yield* Effect.gen(function* () {
        yield* pairAndConnect;
        yield* (yield* Connection)
          .call((rpc) => rpc["settings.get"]())
          .pipe(
            Effect.repeat({
              until: (current) => current.notifications.previews !== before,
              schedule: Schedule.spaced("5 millis"),
            }),
          );
        const other = yield* Settings;
        const back = yield* other.update({
          section: "notifications",
          changes: { previews: before },
        });
        assert.strictEqual(back._tag, "done");
      }).pipe(Effect.scoped, Effect.provide(client()));

      // The first save is answered again, on the next socket, from its receipt.
      yield* network.loseReplies(false);
      yield* network.dropSockets;
      assert.strictEqual((yield* Fiber.join(saving))._tag, "done");
      assert.deepStrictEqual(settings.saves.notifications.get(), {
        _tag: "saved",
        changes: { previews: !before },
      });
      const shown = settings.state.get();
      assert.strictEqual(shown._tag === "ready" && shown.value.notifications.previews, before);
    }).pipe(Effect.scoped, Effect.provide(client())),
  );

  it.effect("shows a change another device made once the settings are read again", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const settings = yield* Settings;
      const loaded = yield* waitFor(settings.state, (state) => state._tag === "ready");
      if (loaded._tag !== "ready") return assert.fail("No settings");
      const before = loaded.value.notifications.previews;

      yield* Effect.gen(function* () {
        yield* pairAndConnect;
        const other = yield* Settings;
        const changed = yield* other.update({
          section: "notifications",
          changes: { previews: !before },
        });
        assert.strictEqual(changed._tag, "done");
      }).pipe(Effect.scoped, Effect.provide(client()));

      yield* settings.refresh;
      const shown = settings.state.get();
      assert.strictEqual(shown._tag === "ready" && shown.value.notifications.previews, !before);
    }).pipe(Effect.scoped, Effect.provide(client())),
  );

  it.effect("gives the operator the first device's time zone, which a later device keeps", () =>
    Effect.gen(function* () {
      /** The zone a device in `timeZone` shows once it connected. */
      const shownOn = (timeZone: string) =>
        Effect.gen(function* () {
          yield* pairAndConnect;
          const shown = yield* waitFor((yield* Settings).state, (state) => state._tag === "ready");
          return shown._tag === "ready" ? shown.value.timeZone : null;
        }).pipe(
          Effect.scoped,
          Effect.provide(client(Option.none(), TestPlatform.makeDevice({ timeZone }))),
        );

      assert.strictEqual(yield* shownOn("America/Sao_Paulo"), "America/Sao_Paulo");
      assert.strictEqual(yield* shownOn("Europe/Lisbon"), "America/Sao_Paulo");
    }),
  );

  it.effect("reads a routine's runs again as one starts, and finds it gone once deleted", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const botId = yield* createBot("Scout");
      const connection = yield* Connection;
      const actions = yield* Actions;
      const details = yield* Details;
      // Its bot's routines are open beside its runs, as on every client.
      yield* details.routines(botId);
      const create = yield* actions.commandId;
      const routine = yield* connection.call((rpc) =>
        rpc["routine.create"]({
          commandId: create,
          botId,
          name: "Prices",
          instruction: "Check the prices.",
          trigger: { _tag: "schedule", cron: "47 8 * * *", timeZone: "UTC" },
        }),
      );
      const runs = yield* details.routineRuns(routine.id);
      yield* waitFor(runs, (state) => state._tag === "ready" && state.value.runs.length === 0);

      // The server records the run as it starts; this server has no runner to carry it on.
      const run = yield* actions.commandId;
      yield* connection.call((rpc) =>
        rpc["routine.run"]({ commandId: run, routineId: routine.id }),
      );
      yield* waitFor(
        runs,
        (state) => state._tag === "ready" && state.value.runs[0]?.status === "running",
      );

      const remove = yield* actions.commandId;
      yield* connection.call((rpc) =>
        rpc["routine.delete"]({ commandId: remove, routineId: routine.id }),
      );
      yield* waitFor(runs, (state) => state._tag === "not-found");
    }).pipe(Effect.scoped, Effect.provide(client())),
  );

  it.effect("changes a bot, and keeps the changes of an update the server refused", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const botId = yield* createBot("Scout");
      const details = yield* Details;
      const roster = yield* Roster;

      const saved = yield* details.updateBot(botId, { profile: { title: "Research" } });
      assert.strictEqual(saved._tag, "done");
      assert.isFalse(details.botSaves.get().has(botId));
      yield* waitFor(
        roster.state,
        (state) =>
          state._tag === "ready" &&
          state.value.some((item) => item._tag === "bot" && item.bot.profile.title === "Research"),
      );

      const changes = {
        profile: { name: "Scout 2" },
        model: { providerId: ProviderId.make("nowhere"), modelId: ModelId.make("none") },
      };
      const refused = yield* details.updateBot(botId, changes);
      assert.deepStrictEqual(refused, {
        _tag: "failed",
        failure: { _tag: "refused", error: new Invalid({ reason: "model" }) },
      });
      assert.deepStrictEqual(details.botSaves.get().get(botId), {
        _tag: "failed",
        changes,
        failure: { _tag: "refused", error: new Invalid({ reason: "model" }) },
      });
    }).pipe(Effect.provide(client())),
  );

  it.effect("refuses a memory write over a revision since replaced, and keeps its text", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const botId = yield* createBot("Scout");
      const details = yield* Details;
      const scope = { _tag: "bot", botId } as const;
      const path = MemoryPath.make("notes.md");
      const list = yield* details.memory(scope);
      yield* waitFor(list, (state) => state._tag === "ready");

      const created = yield* details.writeMemory(scope, path, { text: "one", revision: null });
      if (created._tag !== "done") return assert.fail("The file was not created");
      // The list open beside it reads the new file.
      yield* waitFor(
        list,
        (state) => state._tag === "ready" && state.value.some((file) => file.path === path),
      );
      const read = created.value.revision;
      // Another device writes the file after this one read it.
      const replaced = yield* details.writeMemory(scope, path, { text: "two", revision: read });
      assert.strictEqual(replaced._tag, "done");

      const edit = { text: "three", revision: read };
      const stale = yield* details.writeMemory(scope, path, edit);
      const conflict = {
        _tag: "refused",
        error: new Conflict({ reason: "stale-revision" }),
      } as const;
      assert.deepStrictEqual(stale, { _tag: "failed", failure: conflict });
      assert.deepStrictEqual(details.memorySaves.get().get(memorySaveKey(scope, path)), {
        _tag: "failed",
        changes: edit,
        failure: conflict,
      });
      const kept = yield* details.readMemory(scope, path);
      assert.strictEqual(kept._tag === "done" && kept.value.text, "two");
    }).pipe(Effect.scoped, Effect.provide(client())),
  );

  it.effect("shows no save of a pairing that ended, nor how it ended, under the next one", () =>
    Effect.gen(function* () {
      yield* pairAndConnect;
      const botId = yield* createBot("Scout");
      const details = yield* Details;
      const scope = { _tag: "bot", botId } as const;
      const path = MemoryPath.make("notes.md");
      const refused = yield* details.updateBot(botId, {
        model: { providerId: ProviderId.make("nowhere"), modelId: ModelId.make("none") },
      });
      assert.strictEqual(refused._tag, "failed");
      assert.isTrue(details.botSaves.get().has(botId));

      // A write that waits for the network when the pairing ends.
      const network = yield* TestPlatform.TestNetwork;
      yield* goOffline;
      const writing = yield* details
        .writeMemory(scope, path, { text: "never sent", revision: null })
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.strictEqual(details.memorySaves.get().get(memorySaveKey(scope, path))?._tag, "saving");
      assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "still-listed" });

      assert.deepStrictEqual(yield* Fiber.join(writing), { _tag: "pairing-changed" });
      assert.strictEqual(details.botSaves.get().size, 0);
      assert.strictEqual(details.memorySaves.get().size, 0);
      yield* network.set("online");
      yield* pairAndConnect;
      assert.strictEqual(details.botSaves.get().size, 0);
      assert.strictEqual(details.memorySaves.get().size, 0);
    }).pipe(Effect.scoped, Effect.provide(client())),
  );

  it.effect("reports the view on every socket, and never one set under another pairing", () =>
    Effect.gen(function* () {
      const { views } = yield* Taps;
      const connection = yield* Connection;
      const presence = yield* Presence;
      const network = yield* TestPlatform.TestNetwork;
      /** The next view a socket of `device` reported. */
      const nextView = (device: DeviceId) =>
        Queue.take(views).pipe(
          Effect.repeat({ until: (view) => view.device === device }),
          Effect.map((view) => view.target),
        );

      yield* pairAndConnect;
      const first = yield* connection.deviceId;
      const target: EntryTarget = { _tag: "conversation", botId: yield* createBot("Scout") };
      assert.isNull(yield* nextView(first));
      yield* presence.setView(target);
      assert.deepStrictEqual(yield* nextView(first), target);
      // The server forgets a socket's view with it: the next socket says it again.
      yield* network.dropSockets;
      assert.deepStrictEqual(yield* nextView(first), target);

      // Paired anew, the window shows nothing of the pairing that ended until it says so.
      assert.deepStrictEqual(yield* (yield* SignOut).run, { _tag: "signed-out" });
      yield* pairAndConnect;
      const second = yield* connection.deviceId;
      assert.isNull(yield* nextView(second));
      yield* presence.setView(target);
      assert.deepStrictEqual(yield* nextView(second), target);
    }).pipe(Effect.scoped, Effect.provide(client())),
  );
});
