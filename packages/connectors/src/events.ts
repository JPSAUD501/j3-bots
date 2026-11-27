// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A webhook's HMAC and its secret's randomness are node:crypto's, compared in constant time.
import * as NodeCrypto from "node:crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  canonical,
  cleanDescription,
  cleanObject,
  cleanText,
  MAX_SCHEMA_BYTES,
} from "./catalog.ts";

/**
 * MCP's Events extension (`io.modelcontextprotocol/events`, SEP-3415, on
 * 2026-07-28): a server names the events it can tell a client of
 * (`events/list`), and delivers them by one of three modes the event offers:
 * the client asks (`events/poll`), the server pushes them down a request the
 * client holds open (`events/stream`), or it posts them to an HTTPS address
 * the client gave it (`events/subscribe`, `events/unsubscribe`), signed as
 * Standard Webhooks sign.
 *
 * The SDK J3 Bots uses does not speak it yet: its requests go on the tap of
 * the session's transport (`tap.ts`), and what they answer is read here.
 * This module is what the SDK's own will replace.
 */

export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";

/** How an event reaches the client. */
export const DELIVERY_MODES = ["poll", "push", "webhook"] as const;
export const DeliveryMode = Schema.Literals(DELIVERY_MODES);
export type DeliveryMode = typeof DeliveryMode.Type;

/** The longest event name kept: one longer is left out of a listing. */
const MAX_EVENT_NAME = 256;

/** The most one listing takes, in events: the rest are left out. */
const MAX_LISTED_EVENTS = 200;

/** The most a webhook's body may take, in bytes, as the extension asks servers to keep it. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/** How far a webhook's timestamp may be from now before it is refused, in seconds. */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * An argument the server mirrors into an HTTP header (`x-mcp-header`), which
 * a request over HTTP must carry as `Mcp-Param-{header}`: at `path` in the
 * arguments, of a primitive `type`.
 */
interface ParamHeader {
  readonly path: ReadonlyArray<string>;
  readonly header: string;
}

/** An event its server offers, cleaned as a tool is, for a bot to read and choose. */
export interface EventType {
  readonly name: string;
  readonly description: string;
  readonly delivery: ReadonlyArray<DeliveryMode>;
  /** What its arguments take, as a JSON Schema object. */
  readonly inputSchema: Schema.JsonObject;
  /** What its occurrences carry, as a JSON Schema object; null when it says nothing. */
  readonly payloadSchema: Schema.JsonObject | null;
  readonly headers: ReadonlyArray<ParamHeader>;
}

const ListedEvent = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  delivery: Schema.Array(Schema.String),
  inputSchema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  payloadSchema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const decodeListedEvent = Schema.decodeUnknownOption(ListedEvent);

/** One page of `events/list`. */
const EventsPage = Schema.Struct({
  events: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optionalKey(Schema.String),
});

const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_TYPES = new Set(["string", "integer", "boolean"]);
/** Where an annotation is not allowed: anywhere but a chain of `properties`. */
const ELSEWHERE = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "patternProperties",
  "dependentSchemas",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$defs",
  "definitions",
];

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `x-mcp-header` appears anywhere in `value`. */
const annotatedAnywhere = (value: Schema.Json | undefined): boolean => {
  if (Array.isArray(value)) return value.some(annotatedAnywhere);
  if (!isJsonObject(value)) return false;
  return "x-mcp-header" in value || Object.values(value).some(annotatedAnywhere);
};

/**
 * The headers an event's input schema asks for (2026-07-28 Streamable HTTP,
 * "Custom Headers"), or none when one breaks the transport's rules: a
 * property reached other than through `properties`, a name that is not an
 * HTTP token, a type other than string, integer or boolean, or two names
 * alike but for case. Such an event is left out of the listing, as the
 * extension asks.
 */
const paramHeadersOf = (schema: Schema.JsonObject): Option.Option<ReadonlyArray<ParamHeader>> => {
  const found: Array<ParamHeader> = [];
  const seen = new Set<string>();
  const visit = (node: Schema.JsonObject, path: ReadonlyArray<string>): boolean => {
    const annotation = node["x-mcp-header"];
    if (annotation !== undefined) {
      const type = node["type"];
      if (
        path.length === 0 ||
        typeof annotation !== "string" ||
        !RFC9110_TOKEN.test(annotation) ||
        typeof type !== "string" ||
        !HEADER_TYPES.has(type) ||
        seen.has(annotation.toLowerCase())
      ) {
        return false;
      }
      seen.add(annotation.toLowerCase());
      found.push({ path, header: annotation });
    }
    for (const key of ELSEWHERE) if (annotatedAnywhere(node[key])) return false;
    const properties = node["properties"];
    if (properties === undefined) return true;
    if (!isJsonObject(properties)) return !annotatedAnywhere(properties);
    return Object.entries(properties).every(([key, child]) =>
      isJsonObject(child) ? visit(child, [...path, key]) : !annotatedAnywhere(child),
    );
  };
  return visit(schema, []) ? Option.some(found) : Option.none();
};

/**
 * The events of a listing J3 Bots can offer, cleaned: a name within bounds
 * and not repeated, at least one delivery mode J3 Bots knows, an object
 * input schema within {@link MAX_SCHEMA_BYTES} whose header annotations hold,
 * and the payload schema when it is an object. `redact` takes out the
 * connector's own secrets first; an event whose name or schema keys it would
 * change is left out.
 */
export const eventTypesOf = (
  listed: ReadonlyArray<unknown>,
  redact: (text: string) => string,
): ReadonlyArray<EventType> => {
  const types: Array<EventType> = [];
  const seen = new Set<string>();
  const clean = (text: string) => cleanText(redact(text));
  for (const raw of listed) {
    if (types.length >= MAX_LISTED_EVENTS) break;
    const event = decodeListedEvent(raw);
    if (Option.isNone(event)) continue;
    const { name } = event.value;
    if (name.length === 0 || name.length > MAX_EVENT_NAME || seen.has(name)) continue;
    if (clean(name) !== name) continue;
    const delivery = DELIVERY_MODES.filter((mode) => event.value.delivery.includes(mode));
    if (delivery.length === 0) continue;
    const inputSchema = cleanObject(
      event.value.inputSchema ?? { type: "object", properties: {} },
      clean,
    );
    if (inputSchema === undefined || inputSchema["type"] !== "object") continue;
    if (Buffer.byteLength(canonical(inputSchema), "utf8") > MAX_SCHEMA_BYTES) continue;
    const headers = paramHeadersOf(inputSchema);
    if (Option.isNone(headers)) continue;
    const payload =
      event.value.payloadSchema === undefined
        ? undefined
        : cleanObject(event.value.payloadSchema, clean);
    const payloadSchema =
      payload !== undefined && Buffer.byteLength(canonical(payload), "utf8") <= MAX_SCHEMA_BYTES
        ? payload
        : null;
    seen.add(name);
    types.push({
      name,
      description: cleanDescription(redact(event.value.description ?? "")),
      delivery,
      inputSchema,
      payloadSchema,
      headers: headers.value,
    });
  }
  return types;
};

const BASE64_PREFIX = "=?base64?";
const BASE64_SUFFIX = "?=";

/**
 * A value as an HTTP header carries it (2026-07-28 Streamable HTTP): as it
 * is when it is plain printable ASCII with no space at either end, else
 * wrapped as `=?base64?…?=`.
 */
const headerValue = (value: string): string => {
  const plain =
    value.length > 0 &&
    value === value.trim() &&
    !(value.startsWith(BASE64_PREFIX) && value.endsWith(BASE64_SUFFIX)) &&
    /^[\t\x20-\x7e]*$/.test(value);
  return plain
    ? value
    : `${BASE64_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${BASE64_SUFFIX}`;
};

/** The `Mcp-Param-*` headers a request for `type` with `args` carries over HTTP. */
export const paramHeaders = (
  type: EventType,
  args: Schema.JsonObject,
): Readonly<Record<string, string>> => {
  const headers: Record<string, string> = {};
  for (const { path, header } of type.headers) {
    let value: Schema.Json | undefined = args;
    for (const key of path) value = isJsonObject(value) ? value[key] : undefined;
    const text =
      typeof value === "string"
        ? value
        : typeof value === "boolean"
          ? String(value)
          : typeof value === "number" && Number.isSafeInteger(value)
            ? String(value)
            : undefined;
    if (text !== undefined) headers[`mcp-param-${header.toLowerCase()}`] = headerValue(text);
  }
  return headers;
};

/** The requests of the extension that name an event, and so carry `Mcp-Name` over HTTP. */
const NAMED = new Set(["events/poll", "events/stream", "events/subscribe", "events/unsubscribe"]);

const NamedRequest = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.String,
    params: Schema.Struct({ name: Schema.String }),
  }),
);
const decodeNamedRequest = Schema.decodeUnknownOption(NamedRequest);

/**
 * The `Mcp-Name` an HTTP request's body asks for: one of the extension's
 * requests that names an event carries its name, as the core protocol's
 * `tools/call` does, which the SDK adds itself only for the methods it knows.
 */
export const eventNameHeader = (body: unknown): Option.Option<string> => {
  if (typeof body !== "string" || !body.includes('"events/')) return Option.none();
  return decodeNamedRequest(body).pipe(
    Option.filter((request) => NAMED.has(request.method)),
    Option.map((request) => headerValue(request.params.name)),
  );
};

/**
 * Why a server refused an events request, from the extension's error codes,
 * in J3 Bots' words:
 *
 * - `not-offered`: the server does not speak the extension (`-32601`), or no
 *   longer offers the event (`NotFound` of an event, `-32023`).
 * - `forbidden`: the account no longer has access (`-32024`).
 * - `invalid`: it refused the arguments, the address or the secret (`-32602`).
 * - `exhausted`: it holds too many subscriptions now (`-32025`).
 * - `mode-unsupported`: it does not deliver the event that way (`-32026`,
 *   `deliveryMode`).
 * - `changed`: the event changed under the subscription (`-32026`,
 *   `schema_changed`, or another `Unsupported`).
 * - `callback-failed`: it could not reach or verify the webhook's address
 *   (`-32027`).
 * - `subscription-gone`: it no longer knows the subscription (`NotFound` of
 *   a subscription).
 */
const EVENT_REFUSALS = [
  "not-offered",
  "forbidden",
  "invalid",
  "exhausted",
  "mode-unsupported",
  "changed",
  "callback-failed",
  "subscription-gone",
] as const;
export type EventRefusal = (typeof EVENT_REFUSALS)[number];

/** The server refused an events request, or ended a subscription, for `reason`. */
export class EventsRefused extends Schema.TaggedError<EventsRefused>()("EventsRefused", {
  reason: Schema.Literals(EVENT_REFUSALS),
}) {
  override get message(): string {
    return `A connector's server refused an events request: ${this.reason}.`;
  }
}

const RefusalData = Schema.Struct({
  kind: Schema.optionalKey(Schema.String),
  feature: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});
const decodeRefusalData = Schema.decodeUnknownOption(RefusalData);

/** What an error of the extension's means, or none for an error it does not define. */
export const refusalOf = (code: number, data: unknown): Option.Option<EventRefusal> => {
  const details = Option.getOrElse(decodeRefusalData(data), (): typeof RefusalData.Type => ({}));
  switch (code) {
    case -32601:
      return Option.some("not-offered");
    case -32602:
      return Option.some("invalid");
    case -32023:
      return Option.some(details.kind === "subscription" ? "subscription-gone" : "not-offered");
    case -32024:
      return Option.some("forbidden");
    case -32025:
      return Option.some("exhausted");
    case -32026:
      return Option.some(details.feature === "deliveryMode" ? "mode-unsupported" : "changed");
    case -32027:
      return Option.some("callback-failed");
    default:
      return Option.none();
  }
};

/** An error as an events notification or webhook body carries it. */
const ErrorBody = Schema.Struct({
  code: Schema.Int,
  message: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
});

/**
 * What ended a subscription, from the error its termination carries: one
 * the extension does not define ends it as `forbidden`, the one meaning the
 * server keeps for an end it does not explain.
 */
const terminationOf = (error: typeof ErrorBody.Type): EventRefusal =>
  Option.getOrElse(refusalOf(error.code, error.data), () => "forbidden");

/** A cursor as sent: absent means null. */
const Cursor = Schema.optionalKey(Schema.NullOr(Schema.String));
const cursorOf = (cursor: string | null | undefined): string | null => cursor ?? null;

/** One event, as the server delivers it: its payload is the server's, untrusted. */
const RawOccurrence = Schema.Struct({
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  name: Schema.String,
  timestamp: Schema.String,
  data: Schema.Record(Schema.String, Schema.Json),
  cursor: Cursor,
});

/** An event as J3 Bots keeps it: `data` is the server's payload, untrusted, never instructions. */
export interface Occurrence {
  readonly eventId: string;
  readonly name: string;
  /** When it happened, as the server says, in ISO 8601. */
  readonly timestamp: string;
  readonly data: Schema.JsonObject;
  /** Where the subscription stands after it, for push and webhook; null for poll and for no replay. */
  readonly cursor: string | null;
}

const occurrenceOf = (raw: typeof RawOccurrence.Type): Occurrence => ({
  eventId: raw.eventId,
  name: raw.name,
  timestamp: raw.timestamp,
  data: raw.data,
  cursor: cursorOf(raw.cursor),
});

/** `events/poll`'s answer. */
const RawPoll = Schema.Struct({
  events: Schema.Array(Schema.Unknown),
  cursor: Cursor,
  truncated: Schema.optionalKey(Schema.Boolean),
  hasMore: Schema.optionalKey(Schema.Boolean),
  nextPollMs: Schema.optionalKey(Schema.Finite),
});
const decodeRawPoll = Schema.decodeUnknownOption(RawPoll);
const decodeOccurrence = Schema.decodeUnknownOption(RawOccurrence);

export interface PollAnswer {
  /** The events that decoded: one that did not is dropped, and counts as missed. */
  readonly events: ReadonlyArray<Occurrence>;
  readonly cursor: string | null;
  /** Events may have been missed: the server skipped some, or sent some J3 Bots could not read. */
  readonly truncated: boolean;
  readonly hasMore: boolean;
  /** When to ask again, as the server suggests; null when it does not. */
  readonly nextPollMs: number | null;
}

/** `events/poll`'s answer, or none when it is not one. */
export const pollAnswerOf = (value: unknown): Option.Option<PollAnswer> =>
  Option.map(decodeRawPoll(value), (raw) => {
    const events = raw.events.flatMap((event) =>
      Option.match(decodeOccurrence(event), { onNone: () => [], onSome: (e) => [occurrenceOf(e)] }),
    );
    return {
      events,
      cursor: cursorOf(raw.cursor),
      truncated: raw.truncated === true || events.length < raw.events.length,
      hasMore: raw.hasMore === true,
      nextPollMs: raw.nextPollMs ?? null,
    };
  });

/** What an event stream says, in order. */
export type StreamFrame =
  /** It is open, from `cursor`; `truncated` when events before it may have been missed. */
  | {
      readonly _tag: "active";
      readonly cursor: string | null;
      readonly truncated: boolean;
      readonly heartbeatMs: number | null;
    }
  | { readonly _tag: "event"; readonly occurrence: Occurrence }
  /** Nothing happened up to `cursor`. */
  | { readonly _tag: "heartbeat"; readonly cursor: string | null }
  /** One event failed at the server, which goes on; or an event J3 Bots could not read. */
  | { readonly _tag: "missed" }
  /** The server ended the subscription. */
  | { readonly _tag: "terminated"; readonly reason: EventRefusal };

const Active = Schema.Struct({
  cursor: Cursor,
  truncated: Schema.optionalKey(Schema.Boolean),
  heartbeatMs: Schema.optionalKey(Schema.Finite),
});
const Heartbeat = Schema.Struct({ cursor: Cursor });
const Terminated = Schema.Struct({ error: ErrorBody });
const decodeActive = Schema.decodeUnknownOption(Active);
const decodeHeartbeat = Schema.decodeUnknownOption(Heartbeat);
const decodeTerminated = Schema.decodeUnknownOption(Terminated);

/**
 * A stream's notification, as what it says: none for one J3 Bots does not
 * know, which it passes over. An event that does not decode is `missed`.
 */
export const streamFrameOf = (method: string, params: unknown): Option.Option<StreamFrame> => {
  switch (method) {
    case "notifications/events/active":
      return Option.map(decodeActive(params), (active) => ({
        _tag: "active",
        cursor: cursorOf(active.cursor),
        truncated: active.truncated === true,
        heartbeatMs: active.heartbeatMs ?? null,
      }));
    case "notifications/events/event":
      return Option.some(
        Option.match(decodeOccurrence(params), {
          onNone: (): StreamFrame => ({ _tag: "missed" }),
          onSome: (raw): StreamFrame => ({ _tag: "event", occurrence: occurrenceOf(raw) }),
        }),
      );
    case "notifications/events/heartbeat":
      return Option.map(decodeHeartbeat(params), (beat) => ({
        _tag: "heartbeat",
        cursor: cursorOf(beat.cursor),
      }));
    case "notifications/events/error":
      return Option.some({ _tag: "missed" });
    case "notifications/events/terminated":
      return Option.some({
        _tag: "terminated",
        reason: Option.match(decodeTerminated(params), {
          onNone: (): EventRefusal => "forbidden",
          onSome: (ended) => terminationOf(ended.error),
        }),
      });
    default:
      return Option.none();
  }
};

/** `events/subscribe`'s answer. */
const RawSubscribed = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  refreshBefore: Schema.NullOr(Schema.String),
  cursor: Cursor,
  truncated: Schema.optionalKey(Schema.Boolean),
});
const decodeRawSubscribed = Schema.decodeUnknownOption(RawSubscribed);

export interface SubscribeAnswer {
  /** The server's handle for the subscription, sent with each delivery. */
  readonly id: string;
  /** When it lapses unless renewed, in milliseconds since the epoch; null for never. */
  readonly refreshBefore: number | null;
  readonly cursor: string | null;
  readonly truncated: boolean;
}

/** `events/subscribe`'s answer, or none when it is not one. */
export const subscribeAnswerOf = (value: unknown): Option.Option<SubscribeAnswer> =>
  decodeRawSubscribed(value).pipe(
    Option.flatMap((raw) => {
      const refreshBefore = raw.refreshBefore === null ? null : Date.parse(raw.refreshBefore);
      return refreshBefore !== null && Number.isNaN(refreshBefore)
        ? Option.none()
        : Option.some({
            id: raw.id,
            refreshBefore,
            cursor: cursorOf(raw.cursor),
            truncated: raw.truncated === true,
          });
    }),
  );

/** One page of `events/list`, or none when it is not one. */
export const eventsPageOf = Schema.decodeUnknownOption(EventsPage);

/** The secret's prefix Standard Webhooks gives a symmetric secret. */
const SECRET_PREFIX = "whsec_";

/** A new secret a server signs a webhook's deliveries with: 32 random bytes, as Standard Webhooks writes one. */
export const newWebhookSecret = (): string =>
  `${SECRET_PREFIX}${NodeCrypto.randomBytes(32).toString("base64")}`;

/** Why a webhook's delivery was refused, before anything of it was read. */
export type WebhookRefusal = "unsigned" | "stale" | "bad-signature";

/**
 * Checks a webhook's delivery as Standard Webhooks signs it: the signature
 * over `id.timestamp.body` with `secret`, any of the space-separated `v1,`
 * signatures, compared in constant time; and a timestamp within
 * {@link WEBHOOK_TOLERANCE_SECONDS} of `nowSeconds`.
 */
export const verifyWebhook = (input: {
  readonly secret: string;
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
  readonly body: Uint8Array;
  readonly nowSeconds: number;
}): Option.Option<WebhookRefusal> => {
  const { id, timestamp, signature } = input;
  if (id === null || timestamp === null || signature === null) return Option.some("unsigned");
  if (!/^\d{1,12}$/.test(timestamp)) return Option.some("unsigned");
  if (Math.abs(input.nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) {
    return Option.some("stale");
  }
  if (!input.secret.startsWith(SECRET_PREFIX)) return Option.some("bad-signature");
  const key = Buffer.from(input.secret.slice(SECRET_PREFIX.length), "base64");
  const expected = NodeCrypto.createHmac("sha256", key)
    .update(`${id}.${timestamp}.`, "utf8")
    .update(input.body)
    .digest();
  const matches = signature.split(" ").some((candidate) => {
    if (!candidate.startsWith("v1,")) return false;
    const given = Buffer.from(candidate.slice(3), "base64");
    return given.length === expected.length && NodeCrypto.timingSafeEqual(given, expected);
  });
  return matches ? Option.none() : Option.some("bad-signature");
};

/** Signs a webhook's delivery as a server does: what {@link verifyWebhook} checks. For tests and fakes. */
export const signWebhook = (secret: string, id: string, timestamp: number, body: string): string =>
  `v1,${NodeCrypto.createHmac("sha256", Buffer.from(secret.slice(SECRET_PREFIX.length), "base64"))
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64")}`;

/** What a webhook's body says, once its signature holds. */
export type WebhookBody =
  | { readonly _tag: "event"; readonly occurrence: Occurrence }
  /** Events may have been missed: the subscription goes on from `cursor`. */
  | { readonly _tag: "gap"; readonly cursor: string | null }
  | { readonly _tag: "terminated"; readonly reason: EventRefusal }
  /** The server asks the address to prove it wants deliveries, by echoing `challenge`. */
  | { readonly _tag: "verification"; readonly challenge: string };

const Control = Schema.Union([
  Schema.Struct({ type: Schema.Literal("gap"), cursor: Cursor }),
  Schema.Struct({ type: Schema.Literal("terminated"), error: ErrorBody }),
  Schema.Struct({
    type: Schema.Literal("verification"),
    challenge: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  }),
]);
const decodeControl = Schema.decodeUnknownOption(Control);
const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * A webhook body, read: a control body has a `type`, an event none. None
 * when it is neither, or a control body of a type J3 Bots does not know.
 */
export const webhookBodyOf = (text: string): Option.Option<WebhookBody> =>
  decodeJsonText(text).pipe(
    Option.flatMap((value): Option.Option<WebhookBody> => {
      if (typeof value === "object" && value !== null && "type" in value) {
        return Option.map(decodeControl(value), (control): WebhookBody => {
          switch (control.type) {
            case "gap":
              return { _tag: "gap", cursor: cursorOf(control.cursor) };
            case "terminated":
              return { _tag: "terminated", reason: terminationOf(control.error) };
            case "verification":
              return { _tag: "verification", challenge: control.challenge };
          }
        });
      }
      return Option.map(decodeOccurrence(value), (raw) => ({
        _tag: "event",
        occurrence: occurrenceOf(raw),
      }));
    }),
  );
