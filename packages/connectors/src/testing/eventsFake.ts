// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- A fake server's events for tests, on Node's own HTTP server, with its own heartbeat timer and the wall clock its deliveries are signed by.
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";
import type * as Schema from "effect/Schema";
import { signWebhook } from "../events.ts";

/**
 * The events a fake 2026-07-28 server offers (MCP's Events extension), as
 * `sdkHttpServer.ts` serves them beside the SDK: a log of what happened,
 * read by `events/poll`, pushed down every open `events/stream`, and posted
 * to every webhook subscribed with `events/subscribe`, signed, once the
 * address echoed the server's challenge. Its cursors are positions in the
 * log (`c<n>`); what happened before `forget` was called is gone, and a
 * cursor from then gets `truncated`.
 */

/** What a webhook's delivery is answered with. */
export interface Delivered {
  readonly status: number;
  readonly body: string;
}

export interface EventsFakeOptions {
  /** The events it offers, as `events/list` gives them. */
  readonly types: ReadonlyArray<Schema.JsonObject>;
  /**
   * Where a webhook's delivery goes in place of the network: the test's own
   * receiver, given the address it was subscribed with.
   */
  readonly deliver?: (
    url: string,
    request: { readonly headers: Readonly<Record<string, string>>; readonly body: string },
  ) => Promise<Delivered>;
  /** The heartbeat it grants a stream; 30 seconds when left out. */
  readonly heartbeatMs?: number;
  /** How long it suggests waiting between polls. */
  readonly nextPollMs?: number;
}

/** An error it answers with, or ends a subscription with. */
export interface FakeError {
  readonly code: number;
  readonly message: string;
  readonly data?: Schema.JsonObject;
}

export interface EventsControl {
  /** Something happened: kept in the log, pushed and posted to who listens for `name`. */
  readonly emit: (name: string, data: Schema.JsonObject, eventId?: string) => Promise<void>;
  /** Ends every subscription with `error`; every poll from now on is answered with it. */
  readonly terminate: (error: FakeError) => Promise<void>;
  /** Forgets everything that happened so far: a cursor from before now is past its retention. */
  readonly forget: () => void;
  /** The streams open now. */
  readonly openStreams: () => number;
  /** The webhooks subscribed now. */
  readonly webhooks: () => ReadonlyArray<{ readonly url: string; readonly name: string }>;
  /** The cursors polls and streams were opened with, in order. */
  readonly cursorsAsked: ReadonlyArray<string | null>;
}

interface Rpc {
  readonly id: string | number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface Logged {
  readonly eventId: string;
  readonly name: string;
  readonly timestamp: string;
  readonly data: Schema.JsonObject;
}

interface OpenStream {
  readonly name: string;
  readonly id: string | number;
  readonly write: (method: string, params: Readonly<Record<string, unknown>>) => void;
  readonly end: () => void;
}

interface Webhook {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly secret: string;
}

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

const json = (response: NodeHttp.ServerResponse, value: unknown) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const answer = (response: NodeHttp.ServerResponse, id: string | number, result: unknown) =>
  json(response, { jsonrpc: "2.0", id, result: { resultType: "complete", ...Object(result) } });

const refuse = (response: NodeHttp.ServerResponse, id: string | number, error: FakeError) =>
  json(response, { jsonrpc: "2.0", id, error });

const cursorAt = (position: number) => `c${position}`;
const positionOf = (cursor: unknown): number | null =>
  typeof cursor === "string" && /^c\d+$/.test(cursor) ? Number(cursor.slice(1)) : null;

export const eventsFake = (options: EventsFakeOptions) => {
  const log: Array<Logged> = [];
  let retainedFrom = 0;
  let ended: FakeError | null = null;
  const streams = new Set<OpenStream>();
  const webhooks = new Map<string, Webhook>();
  const verified = new Set<string>();
  const cursorsAsked: Array<string | null> = [];
  const names = new Set(options.types.map((type) => type["name"]));

  const occurrence = (logged: Logged, position: number) => ({
    ...logged,
    cursor: cursorAt(position + 1),
  });

  /** Where a cursor starts reading, and whether events before it are gone. */
  const startOf = (cursor: unknown): { readonly from: number; readonly truncated: boolean } => {
    const position = positionOf(cursor);
    if (position === null) return { from: log.length, truncated: false };
    return position < retainedFrom
      ? { from: retainedFrom, truncated: true }
      : { from: Math.min(position, log.length), truncated: false };
  };

  const post = async (hook: Webhook, body: Readonly<Record<string, unknown>>) => {
    if (options.deliver === undefined) return { status: 503, body: "" };
    const text = JSON.stringify(body);
    const messageId = `msg_${NodeCrypto.randomBytes(9).toString("base64url")}`;
    const timestamp = Math.floor(Date.now() / 1000);
    return options.deliver(hook.url, {
      headers: {
        "content-type": "application/json",
        "webhook-id": messageId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signWebhook(hook.secret, messageId, timestamp, text),
        "x-mcp-subscription-id": hook.id,
      },
      body: text,
    });
  };

  const control: EventsControl = {
    emit: async (name, data, eventId) => {
      const logged: Logged = {
        eventId: eventId ?? `evt_${log.length + 1}`,
        name,
        timestamp: new Date().toISOString(),
        data,
      };
      log.push(logged);
      const body = occurrence(logged, log.length - 1);
      for (const stream of streams) {
        if (stream.name === name) stream.write("notifications/events/event", body);
      }
      for (const hook of webhooks.values()) if (hook.name === name) await post(hook, body);
    },
    terminate: async (error) => {
      ended = error;
      for (const stream of streams) {
        stream.write("notifications/events/terminated", { error });
        stream.end();
      }
      streams.clear();
      for (const hook of webhooks.values()) await post(hook, { type: "terminated", error });
      webhooks.clear();
    },
    forget: () => {
      retainedFrom = log.length;
    },
    openStreams: () => streams.size,
    webhooks: () => [...webhooks.values()].map(({ url, name }) => ({ url, name })),
    cursorsAsked,
  };

  /** Answers one of the extension's requests: false when it is not one. */
  const handle = (rpc: Rpc, response: NodeHttp.ServerResponse): boolean => {
    if (!rpc.method.startsWith("events/")) return false;
    const name = rpc.params["name"];
    if (rpc.method === "events/list") {
      answer(response, rpc.id, { events: options.types });
      return true;
    }
    if (typeof name !== "string" || !names.has(name)) {
      refuse(response, rpc.id, { code: -32023, message: "NotFound", data: { kind: "event" } });
      return true;
    }
    if (ended !== null) {
      refuse(response, rpc.id, ended);
      return true;
    }
    switch (rpc.method) {
      case "events/poll": {
        cursorsAsked.push(
          positionOf(rpc.params["cursor"]) === null ? null : String(rpc.params["cursor"]),
        );
        const { from, truncated } = startOf(rpc.params["cursor"]);
        const max = typeof rpc.params["maxEvents"] === "number" ? rpc.params["maxEvents"] : 50;
        const events = log.slice(from, from + max).filter((logged) => logged.name === name);
        const next = Math.min(log.length, from + max);
        answer(response, rpc.id, {
          events,
          cursor: cursorAt(next),
          truncated,
          hasMore: next < log.length,
          nextPollMs: options.nextPollMs ?? 1_000,
        });
        return true;
      }
      case "events/stream": {
        cursorsAsked.push(
          positionOf(rpc.params["cursor"]) === null ? null : String(rpc.params["cursor"]),
        );
        const { from, truncated } = startOf(rpc.params["cursor"]);
        const heartbeatMs = options.heartbeatMs ?? 30_000;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const write = (method: string, params: Readonly<Record<string, unknown>>) =>
          void response.write(
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              method,
              params: { ...params, _meta: { [SUBSCRIPTION_ID]: rpc.id } },
            })}\n\n`,
          );
        const beat = setInterval(
          () => write("notifications/events/heartbeat", { cursor: cursorAt(log.length) }),
          heartbeatMs,
        );
        const stream: OpenStream = {
          name,
          id: rpc.id,
          write,
          end: () => {
            clearInterval(beat);
            response.end();
          },
        };
        response.on("close", () => {
          clearInterval(beat);
          streams.delete(stream);
        });
        write("notifications/events/active", {
          cursor: cursorAt(from),
          truncated,
          heartbeatMs,
        });
        log.slice(from).forEach((logged, offset) => {
          if (logged.name === name)
            write("notifications/events/event", occurrence(logged, from + offset));
        });
        streams.add(stream);
        return true;
      }
      case "events/subscribe": {
        const delivery = rpc.params["delivery"];
        const url =
          typeof delivery === "object" && delivery !== null && "url" in delivery
            ? delivery.url
            : undefined;
        const secret =
          typeof delivery === "object" && delivery !== null && "secret" in delivery
            ? delivery.secret
            : undefined;
        if (
          typeof url !== "string" ||
          !url.startsWith("https://") ||
          typeof secret !== "string" ||
          !/^whsec_[A-Za-z0-9+/=]{32,}$/.test(secret)
        ) {
          refuse(response, rpc.id, { code: -32602, message: "InvalidParams" });
          return true;
        }
        const id = `sub_${NodeCrypto.createHash("sha256").update(`${url}\n${name}`).digest("hex").slice(0, 16)}`;
        const hook: Webhook = { id, url, name, secret };
        const subscribed = () => {
          webhooks.set(id, hook);
          const { truncated } = startOf(rpc.params["cursor"]);
          answer(response, rpc.id, {
            id,
            refreshBefore: new Date(
              Date.now() +
                (typeof rpc.params["ttlMs"] === "number" ? rpc.params["ttlMs"] : 3_600_000),
            ).toISOString(),
            cursor: cursorAt(log.length),
            truncated,
          });
        };
        if (verified.has(url)) {
          subscribed();
          return true;
        }
        const challenge = NodeCrypto.randomBytes(12).toString("hex");
        void post(hook, { type: "verification", challenge }).then(
          (reply) => {
            const echoed =
              reply.status >= 200 &&
              reply.status < 300 &&
              reply.body === JSON.stringify({ challenge });
            if (!echoed) {
              return refuse(response, rpc.id, {
                code: -32027,
                message: "CallbackEndpointError",
                data: { reason: "challenge_failed" },
              });
            }
            verified.add(url);
            subscribed();
          },
          () =>
            refuse(response, rpc.id, {
              code: -32027,
              message: "CallbackEndpointError",
              data: { reason: "connection_refused" },
            }),
        );
        return true;
      }
      case "events/unsubscribe": {
        const delivery = rpc.params["delivery"];
        const url =
          typeof delivery === "object" && delivery !== null && "url" in delivery
            ? delivery.url
            : undefined;
        for (const [id, hook] of webhooks) {
          if (hook.url === url && hook.name === name) webhooks.delete(id);
        }
        answer(response, rpc.id, {});
        return true;
      }
      default:
        refuse(response, rpc.id, { code: -32601, message: "Method not found" });
        return true;
    }
  };

  return { control, handle };
};
