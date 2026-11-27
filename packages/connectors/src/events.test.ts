// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { InMemoryResponseCacheStore } from "@modelcontextprotocol/client";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import {
  eventTypesOf,
  newWebhookSecret,
  signWebhook,
  type StreamFrame,
  verifyWebhook,
  webhookBodyOf,
} from "./events.ts";
import type { UrlPolicy } from "./guard.ts";
import {
  type ConnectorCredentials,
  DEFAULT_SESSION_LIMITS,
  type McpEvents,
  openSession,
} from "./session.ts";
import { type EventsFakeOptions, sdkHttpServer } from "./testing/sdkHttpServer.ts";

/**
 * MCP's Events extension as J3 Bots speaks it (`events.ts`): against a fake
 * 2026-07-28 server built on the SDK's own, which serves events beside it,
 * in each of the three ways an event is delivered.
 */

const POLICY: UrlPolicy = {
  loopback: "allow-http",
  privateNetwork: "refuse",
  redirects: "recheck",
};
const NO_CREDENTIALS: ConnectorCredentials = {
  current: Effect.succeed({ bearer: Option.none(), headers: [], hidden: [], carried: [] }),
  rejected: () => Effect.void,
};

/** A sign-in whose token changes with each request, as one renewed often would. */
const rotating = (): ConnectorCredentials => {
  let renewed = 0;
  return {
    current: Effect.sync(() => {
      renewed += 1;
      return {
        bearer: Option.some(Redacted.make(`token-${renewed}-of-the-mail-sign-in`)),
        headers: [],
        hidden: [],
        carried: [],
      };
    }),
    rejected: () => Effect.void,
  };
};

const RECEIVED: Schema.JsonObject = {
  name: "message.received",
  description: "A message arrived.",
  delivery: ["poll", "push", "webhook"],
  inputSchema: {
    type: "object",
    properties: {
      folder: { type: "string", "x-mcp-header": "Folder" },
      from: { type: "string" },
    },
  },
  payloadSchema: { type: "object", properties: { subject: { type: "string" } } },
};

const serve = (
  options: Partial<EventsFakeOptions> = {},
  credentials: ConnectorCredentials = NO_CREDENTIALS,
) =>
  Effect.gen(function* () {
    const fake = yield* sdkHttpServer({
      revision: "2026-07-28",
      events: { types: [RECEIVED], ...options },
    });
    const session = yield* openSession({
      url: new URL(fake.url),
      policy: POLICY,
      credentials,
      limits: DEFAULT_SESSION_LIMITS,
      client: { name: "j3-bots-test", version: "0.0.0" },
      cache: new InMemoryResponseCacheStore(),
      onListChanged: () => Effect.void,
    });
    const events = session.events;
    const control = fake.events;
    if (events === null || control === null) return yield* Effect.die("events are offered");
    const [type] = yield* events.list;
    if (type === undefined) return yield* Effect.die("the event is listed");
    return { fake, events, control, type };
  });

const ARGS = { folder: "Inbox", from: "ana@example.com" };

describe("listing", () => {
  it.effect(
    "keeps the events J3 Bots can subscribe to, and the headers their arguments ask for",
    () =>
      Effect.sync(() => {
        const types = eventTypesOf(
          [
            RECEIVED,
            { ...RECEIVED, name: "only.unknown", delivery: ["carrier-pigeon"] },
            {
              ...RECEIVED,
              name: "bad.header",
              inputSchema: {
                type: "object",
                properties: { tags: { type: "array", items: { "x-mcp-header": "Tag" } } },
              },
            },
            {
              ...RECEIVED,
              name: "number.header",
              inputSchema: {
                type: "object",
                properties: { limit: { type: "number", "x-mcp-header": "Limit" } },
              },
            },
            RECEIVED,
          ],
          (text) => text,
        );
        assert.deepStrictEqual(
          types.map((type) => type.name),
          ["message.received"],
        );
        assert.deepStrictEqual(types[0]?.headers, [{ path: ["folder"], header: "Folder" }]);
      }),
  );

  it.effect("sends nothing of the extension to a server that does not offer it", () =>
    Effect.gen(function* () {
      const fake = yield* sdkHttpServer({ revision: "2026-07-28" });
      const session = yield* openSession({
        url: new URL(fake.url),
        policy: POLICY,
        credentials: NO_CREDENTIALS,
        limits: DEFAULT_SESSION_LIMITS,
        client: { name: "j3-bots-test", version: "0.0.0" },
        cache: new InMemoryResponseCacheStore(),
        onListChanged: () => Effect.void,
      });
      assert.isFalse(session.info.offers.events);
      assert.isNull(session.events);
      yield* session.listTools;
      assert.isFalse(fake.requests.some((r) => r.method.startsWith("events/")));
    }).pipe(Effect.scoped),
  );
});

describe("poll", () => {
  it.live(
    "starts from now, reads what happened since its cursor, and names it in its headers",
    () =>
      Effect.gen(function* () {
        const { fake, events, control, type } = yield* serve();
        yield* Effect.promise(() => control.emit("message.received", { subject: "before" }));
        const first = yield* events.poll({
          type,
          arguments: ARGS,
          cursor: null,
          maxAgeMs: 60_000,
          maxEvents: 10,
        });
        assert.deepStrictEqual(first.events, []);
        yield* Effect.promise(() => control.emit("message.received", { subject: "Lunch?" }));
        const second = yield* events.poll({
          type,
          arguments: ARGS,
          cursor: first.cursor,
          maxAgeMs: 60_000,
          maxEvents: 10,
        });
        assert.deepStrictEqual(
          second.events.map((event) => event.data),
          [{ subject: "Lunch?" }],
        );
        assert.isFalse(second.truncated);
        const polled = fake.requests.filter((r) => r.method === "events/poll");
        assert.strictEqual(polled[0]?.headers["mcp-name"], "message.received");
        assert.strictEqual(polled[0]?.headers["mcp-param-folder"], "Inbox");
        // The extension's requests carry the envelope the SDK frames its own
        // with: the SDK names the method in a header only from the envelope.
        const listing = fake.requests.find((r) => r.method === "events/list");
        assert.strictEqual(listing?.headers["mcp-method"], "events/list");
      }).pipe(Effect.scoped),
  );

  it.live("says events may have been missed when its cursor is past what the server keeps", () =>
    Effect.gen(function* () {
      const { events, control, type } = yield* serve();
      const first = yield* events.poll({
        type,
        arguments: ARGS,
        cursor: null,
        maxAgeMs: 60_000,
        maxEvents: 10,
      });
      yield* Effect.promise(() => control.emit("message.received", { subject: "lost" }));
      control.forget();
      const second = yield* events.poll({
        type,
        arguments: ARGS,
        cursor: first.cursor,
        maxAgeMs: 60_000,
        maxEvents: 10,
      });
      assert.isTrue(second.truncated);
      assert.deepStrictEqual(second.events, []);
    }).pipe(Effect.scoped),
  );

  it.live("reads a refusal the extension defines as one, and an ended subscription", () =>
    Effect.gen(function* () {
      const { events, control, type } = yield* serve();
      const unknown = yield* Effect.flip(
        events.poll({
          type: { ...type, name: "message.deleted" },
          arguments: ARGS,
          cursor: null,
          maxAgeMs: 60_000,
          maxEvents: 10,
        }),
      );
      assert.deepInclude(unknown, { _tag: "EventsRefused", reason: "not-offered" });
      yield* Effect.promise(() =>
        control.terminate({ code: -32024, message: "Forbidden", data: { reason: "revoked" } }),
      );
      const revoked = yield* Effect.flip(
        events.poll({ type, arguments: ARGS, cursor: null, maxAgeMs: 60_000, maxEvents: 10 }),
      );
      assert.deepInclude(revoked, { _tag: "EventsRefused", reason: "forbidden" });
    }).pipe(Effect.scoped),
  );
});

/** Holds `events`' stream open, keeping its frames, until it ends. */
const streaming = (events: McpEvents, input: Parameters<McpEvents["stream"]>[0]) =>
  Effect.gen(function* () {
    const frames: Array<StreamFrame> = [];
    const active = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      events.stream(input, (frame) =>
        Effect.sync(() => frames.push(frame)).pipe(
          Effect.andThen(
            frame._tag === "active" ? Deferred.succeed(active, undefined) : Effect.void,
          ),
        ),
      ),
    );
    yield* Deferred.await(active);
    return { frames, fiber };
  });

const until = (holds: () => boolean) =>
  Effect.gen(function* () {
    while (!holds()) yield* Effect.sleep("20 millis");
  }).pipe(Effect.timeout("5 seconds"));

describe("stream", () => {
  it.live(
    "pushes each event as it happens, and resumes from its cursor after the stream ends",
    () =>
      Effect.gen(function* () {
        const { events, control, type } = yield* serve();
        const input = {
          type,
          arguments: ARGS,
          cursor: null,
          maxAgeMs: 60_000,
          heartbeatMs: 30_000,
        };
        const first = yield* streaming(events, input);
        yield* Effect.promise(() => control.emit("message.received", { subject: "one" }));
        yield* until(() => first.frames.some((frame) => frame._tag === "event"));
        const event = first.frames.find((frame) => frame._tag === "event");
        assert.deepInclude(event?._tag === "event" ? event.occurrence : undefined, {
          data: { subject: "one" },
          cursor: "c1",
        });
        // Interrupting it cancels the stream at the server.
        yield* Fiber.interrupt(first.fiber);
        yield* until(() => control.openStreams() === 0);
        yield* Effect.promise(() => control.emit("message.received", { subject: "two" }));
        const second = yield* streaming(events, { ...input, cursor: "c1" });
        yield* until(() => second.frames.some((frame) => frame._tag === "event"));
        const replayed = second.frames.find((frame) => frame._tag === "event");
        assert.deepInclude(replayed?._tag === "event" ? replayed.occurrence : undefined, {
          data: { subject: "two" },
        });
        assert.deepStrictEqual(control.cursorsAsked, [null, "c1"]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "cleans an event of the token its stream was opened with, after the session's token changed",
    () =>
      Effect.gen(function* () {
        const { fake, events, control, type } = yield* serve({}, rotating());
        const opened = yield* streaming(events, {
          type,
          arguments: ARGS,
          cursor: null,
          maxAgeMs: 60_000,
          heartbeatMs: 30_000,
        });
        const signed = fake.requests.find((r) => r.method === "events/stream")?.headers
          .authorization;
        const token = signed?.slice("Bearer ".length) ?? "";
        assert.include(token, "of-the-mail-sign-in");
        // Five requests signed since, each with a token of its own.
        for (let request = 0; request < 5; request++) yield* events.list;
        yield* Effect.promise(() =>
          control.emit("message.received", { subject: `Your token is ${token}` }),
        );
        yield* until(() => opened.frames.some((frame) => frame._tag === "event"));
        const event = opened.frames.find((frame) => frame._tag === "event");
        const data = event?._tag === "event" ? JSON.stringify(event.occurrence.data) : "";
        assert.include(data, "Your token is");
        assert.notInclude(data, token);
      }).pipe(Effect.scoped),
  );

  it.live("ends with the server's reason when it ends the subscription", () =>
    Effect.gen(function* () {
      const { events, control, type } = yield* serve();
      const { fiber } = yield* streaming(events, {
        type,
        arguments: ARGS,
        cursor: null,
        maxAgeMs: 60_000,
        heartbeatMs: 30_000,
      });
      yield* Effect.promise(() =>
        control.terminate({ code: -32023, message: "NotFound", data: { kind: "event" } }),
      );
      const ended = yield* Effect.flip(Fiber.join(fiber));
      assert.deepInclude(ended, { _tag: "EventsRefused", reason: "not-offered" });
    }).pipe(Effect.scoped),
  );
});

describe("webhook", () => {
  it.live(
    "subscribes once its address answers the server's challenge, signed with its secret",
    () =>
      Effect.gen(function* () {
        const secret = newWebhookSecret();
        const received: Array<string> = [];
        const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const { events, control, type } = yield* serve({
          deliver: async (_url, request) => {
            const refused = verifyWebhook({
              secret,
              id: request.headers["webhook-id"] ?? null,
              timestamp: request.headers["webhook-timestamp"] ?? null,
              signature: request.headers["webhook-signature"] ?? null,
              body: new TextEncoder().encode(request.body),
              nowSeconds,
            });
            if (Option.isSome(refused)) return { status: 401, body: "" };
            const body = webhookBodyOf(request.body);
            if (Option.isNone(body)) return { status: 400, body: "" };
            if (body.value._tag === "verification") {
              return { status: 200, body: JSON.stringify({ challenge: body.value.challenge }) };
            }
            received.push(body.value._tag);
            return { status: 200, body: "" };
          },
        });
        const url = "https://j3.example/hooks/events/tok";
        const answer = yield* events.subscribe({
          type,
          arguments: ARGS,
          url,
          secret: Redacted.make(secret),
          cursor: null,
          maxAgeMs: 60_000,
          ttlMs: 3_600_000,
        });
        assert.match(answer.id, /^sub_/);
        assert.isAbove(answer.refreshBefore ?? 0, yield* Clock.currentTimeMillis);
        yield* Effect.promise(() => control.emit("message.received", { subject: "hook" }));
        assert.deepStrictEqual(received, ["event"]);
        yield* events.unsubscribe({ type, arguments: ARGS, url });
        assert.deepStrictEqual(control.webhooks(), []);
      }).pipe(Effect.scoped),
  );

  it.live("is refused when its address does not answer the challenge", () =>
    Effect.gen(function* () {
      const { events, type } = yield* serve({
        deliver: async () => ({ status: 200, body: "{}" }),
      });
      const refused = yield* Effect.flip(
        events.subscribe({
          type,
          arguments: ARGS,
          url: "https://j3.example/hooks/events/tok",
          secret: Redacted.make(newWebhookSecret()),
          cursor: null,
          maxAgeMs: 60_000,
          ttlMs: 3_600_000,
        }),
      );
      assert.deepInclude(refused, { _tag: "EventsRefused", reason: "callback-failed" });
    }).pipe(Effect.scoped),
  );
});

describe("verifyWebhook", () => {
  const secret = newWebhookSecret();
  const body =
    '{"eventId":"evt_1","name":"message.received","timestamp":"2026-11-27T10:00:00Z","data":{}}';
  const now = 1_800_000_000;
  const check = (signature: string, timestamp = now, sent = body) =>
    verifyWebhook({
      secret,
      id: "msg_1",
      timestamp: String(timestamp),
      signature,
      body: new TextEncoder().encode(sent),
      nowSeconds: now,
    });

  it("takes a delivery signed with its secret, among others during a rotation", () => {
    const good = signWebhook(secret, "msg_1", now, body);
    assert.isTrue(Option.isNone(check(good)));
    const other = signWebhook(newWebhookSecret(), "msg_1", now, body);
    assert.isTrue(Option.isNone(check(`${other} ${good}`)));
  });

  it("refuses one signed otherwise, changed on the way, or too old", () => {
    const other = signWebhook(newWebhookSecret(), "msg_1", now, body);
    assert.deepStrictEqual(check(other), Option.some("bad-signature"));
    const good = signWebhook(secret, "msg_1", now, body);
    assert.deepStrictEqual(
      check(good, now, body.replace("evt_1", "evt_2")),
      Option.some("bad-signature"),
    );
    const late = signWebhook(secret, "msg_1", now - 600, body);
    assert.deepStrictEqual(check(late, now - 600), Option.some("stale"));
    assert.deepStrictEqual(
      verifyWebhook({
        secret,
        id: null,
        timestamp: String(now),
        signature: good,
        body: new TextEncoder().encode(body),
        nowSeconds: now,
      }),
      Option.some("unsigned"),
    );
  });
});
