// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Which effect a request from inside the SDK belongs to is known only through node:async_hooks, and a call's tag is node:crypto's.
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeCrypto from "node:crypto";
import type { Elicitation, ElicitationAnswer } from "@j3-bots/contracts";
import {
  Client,
  InMemoryResponseCacheStore,
  ProtocolError,
  type ResponseCacheStore,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type Transport,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/client";
import {
  fitsUtf8,
  MAX_CONNECTOR_APP_DATA_BYTES,
  MCP_APP_MIME_TYPE,
  MCP_APPS_EXTENSION,
} from "@j3-bots/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { blobText } from "./app.ts";
import { type CatalogTool, catalogOf, cleanTitle, ListedTool, toolBytes } from "./catalog.ts";
import { answerText, CallResult, contentText, ResourceContents } from "./content.ts";
import { elicitationOf, elicitResultOf } from "./elicitation.ts";
import {
  AuthFailing,
  CommandFailed,
  type ConnectorFailure,
  type CredentialsUnavailable,
  NeedsSignIn,
  NotMcp,
  ResponseTooLarge,
  ServerError,
  TimedOut,
  Unreachable,
  UrlRefused,
  SecretNeeded,
  SecretsUnavailable,
  StepNotFinished,
  Withdrawn,
} from "./errors.ts";
import { entryBytes, type Prompt, promptsOf, type Resource, resourcesOf } from "./features.ts";
import {
  DEFAULT_GUARD,
  type GuardedFetch,
  type GuardOptions,
  makeGuardedFetch,
  type UrlPolicy,
} from "./guard.ts";
import {
  CALL_TAG,
  DetailedTask,
  RawRequestClosed,
  RawRequestError,
  TASKS_EXTENSION,
  type Task,
  type ProgressStep,
  type TaskTap,
  tapTransport,
} from "./tasks.ts";
import { codePointsEnd } from "./text.ts";

/**
 * A connection to a connector's MCP server (`docs/architecture/server.md`,
 * "Connectors"), at the current revision of MCP (2026-07-28) or, with a
 * server that does not speak it, the one it does (2025-11-25 and earlier).
 *
 * The client finds which by asking the server (`server/discover`): a server
 * that answers is spoken to statelessly, each request carrying what the
 * revision's envelope says; one that refuses, or does not know the method,
 * gets the earlier `initialize` handshake. Over Streamable HTTP a server
 * that stays silent is down, not old; over a process's streams it is old.
 *
 * Its credentials are read from their store for every request and added
 * then; nothing here keeps a token or a header's value between requests.
 */

/** A header J3 Bots adds to each request, with its value from the store. */
export interface SecretHeader {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

/**
 * What signs one request: a bearer token from a sign-in, and headers the
 * operator gave. `hidden` are secrets the request carries only inside
 * another value, as the key a `Bearer {key}` header or a path was made from,
 * each as it may appear: never sent as they are, only taken out of what the
 * server answers. Each is known to be a secret, so one too short to look for
 * inside other text is still taken out where it stands as a word of its own
 * (`scrubberOf`). `carried` are other values a request carries only inside
 * another, not known to be secrets, as a login's user name: taken out as the
 * headers' values are, never as a word, since a short one is ordinary text.
 */
export interface CallCredentials {
  readonly bearer: Option.Option<Redacted.Redacted<string>>;
  readonly headers: ReadonlyArray<SecretHeader>;
  readonly hidden: ReadonlyArray<Redacted.Redacted<string>>;
  readonly carried: ReadonlyArray<Redacted.Redacted<string>>;
}

/** Whether two requests carry the same headers, in order. */
export const sameHeaders = (
  a: ReadonlyArray<SecretHeader>,
  b: ReadonlyArray<SecretHeader>,
): boolean =>
  a.length === b.length &&
  a.every(
    (header, i) =>
      header.name === b[i]?.name && Redacted.value(header.value) === Redacted.value(b[i].value),
  );

/** Whether two requests were signed alike: the same token and the same headers. */
const sameCredentials = (a: CallCredentials, b: CallCredentials): boolean =>
  Option.makeEquivalence(
    (x: Redacted.Redacted<string>, y: Redacted.Redacted<string>) =>
      Redacted.value(x) === Redacted.value(y),
  )(a.bearer, b.bearer) && sameHeaders(a.headers, b.headers);

/** Where a session reads its credentials, at each request. */
export interface ConnectorCredentials {
  readonly current: Effect.Effect<CallCredentials, CredentialsUnavailable>;
  /**
   * The server refused the credentials just sent (`sent`), with this
   * `WWW-Authenticate`: renew them (a refresh), let the request go again
   * when they were replaced meanwhile (a token another request renewed, a
   * header's value given again), or fail. The request is sent once more with
   * what `current` gives next.
   */
  readonly rejected: (
    wwwAuthenticate: Option.Option<string>,
    sent: CallCredentials,
  ) => Effect.Effect<void, CredentialsUnavailable>;
  /**
   * The server refused the credentials sent again, `sent`, after `rejected`,
   * with this `WWW-Authenticate`: what that means for them. It fails for a
   * connector that signs in as a service, whose credentials were refused or
   * lack a scope; when it succeeds, or is left out, the operator must sign
   * in again (`NeedsSignIn`).
   */
  readonly refusedAgain?: (
    wwwAuthenticate: Option.Option<string>,
    sent: CallCredentials,
  ) => Effect.Effect<void, CredentialsUnavailable>;
}

export interface SessionLimits {
  /** How long opening the session, or one listing, may take. */
  readonly listDeadline: Duration.Duration;
  /**
   * How long one tool call, resource read or prompt may take before its
   * server answers it, or answers with a task: each can wait on the operator.
   */
  readonly callDeadline: Duration.Duration;
  /** How long a call its server runs as a task may take in all, from the call. */
  readonly taskDeadline: Duration.Duration;
  /** The most characters of a tool's answer, a resource or a prompt a reader gets; the rest is cut. */
  readonly maxResultCharacters: number;
  /** The most one listing's answers may take, in bytes, across its pages: past it, the listing fails. */
  readonly maxCatalogBytes: number;
  /** The most pages one listing may take. */
  readonly maxListPages: number;
  readonly guard: GuardOptions;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  listDeadline: Duration.seconds(30),
  callDeadline: Duration.minutes(10),
  taskDeadline: Duration.minutes(60),
  maxResultCharacters: 100_000,
  maxCatalogBytes: 8 * 1024 * 1024,
  maxListPages: 64,
  guard: DEFAULT_GUARD,
};

/** What a server lists: its tools, its resources, its prompts. */
export type ListKind = "tools" | "resources" | "prompts";

/** What a session needs from the connector it serves, whatever the transport. */
export interface ClientSetup {
  /** How J3 Bots names itself to the server. */
  readonly client: { readonly name: string; readonly version: string };
  /**
   * Where the server's cacheable answers (its lists, its resources) are kept
   * for as long as it says they hold: one store for the connector, shared by
   * its sessions, which are all signed alike.
   */
  readonly cache: ResponseCache;
  /** The server said one of its lists changed. */
  readonly onListChanged: (kind: ListKind) => Effect.Effect<void>;
}

/** Where a connector's cacheable answers are kept ({@link ClientSetup.cache}). */
export type ResponseCache = ResponseCacheStore;

/** A connector's response cache: empty, and kept in memory only. */
export const responseCache = (): ResponseCache => new InMemoryResponseCacheStore();

export interface SessionOptions extends ClientSetup {
  readonly url: URL;
  readonly policy: UrlPolicy;
  readonly credentials: ConnectorCredentials;
  readonly limits: SessionLimits;
}

/** What a tool answered, as a bot may read it: cut to size, with the connector's secrets taken out. */
export interface ToolAnswer {
  readonly text: string;
  readonly isError: boolean;
  /** Part of the answer was cut to fit `maxResultCharacters`. */
  readonly cut: boolean;
  /**
   * The answer whole, as MCP gives it (`CallToolResult`), with the
   * connector's secrets taken out, for an app to be given; null when it is
   * larger than `MAX_CONNECTOR_APP_DATA_BYTES` as JSON.
   */
  readonly result: Schema.Json | null;
}

/** How far a call has come, as its server says: progress, or the status of the task it runs as. */
export interface CallProgress {
  /** What the server says it is doing, cleaned, in a line; null when it says nothing. */
  readonly message: string | null;
  /** How much is done, from 0 to 1, when the server gives a total. */
  readonly fraction: number | null;
}

/**
 * What one call can reach while it runs: where its progress goes, and who
 * answers when its server asks for something. Without them, progress is
 * dropped and every request for input declined.
 */
export interface CallHooks {
  readonly progress: (progress: CallProgress) => Effect.Effect<void>;
  /** Shows the request to the operator and waits for their answer; interrupted when the call ends. */
  readonly elicit: (elicitation: Elicitation) => Effect.Effect<ElicitationAnswer>;
}

/** Which revision of MCP the server speaks, who it says it is, and what it offers. */
export interface ServerInfo {
  /** The protocol revision negotiated, such as `2026-07-28` or `2025-11-25`. */
  readonly protocolVersion: string;
  /** Its name and version as it gives them, cleaned; null when it gives none. */
  readonly name: string | null;
  readonly version: string | null;
  readonly offers: {
    readonly tools: boolean;
    readonly resources: boolean;
    readonly prompts: boolean;
    /** Whether it may run a call as a task (the Tasks extension). */
    readonly tasks: boolean;
  };
}

/** A resource's contents as a reader gets them: the connector's secrets taken out of its text, cut to size. */
export interface ResourceRead {
  readonly contents: ReadonlyArray<ResourceContents>;
  /** Part of it was cut, or binary contents left out, to fit `maxResultCharacters`. */
  readonly cut: boolean;
}

/** A prompt as its server wrote it from the arguments given: its messages as text. */
export interface PromptText {
  readonly description: string | null;
  readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>;
  readonly cut: boolean;
}

export interface McpSession {
  readonly info: ServerInfo;
  /** Every tool its server lists, cleaned, with the connector's secrets taken out. */
  readonly listTools: Effect.Effect<ReadonlyArray<CatalogTool>, ConnectorFailure>;
  /** Every resource and resource template its server lists, cleaned. */
  readonly listResources: Effect.Effect<ReadonlyArray<Resource>, ConnectorFailure>;
  /** Every prompt its server lists, cleaned. */
  readonly listPrompts: Effect.Effect<ReadonlyArray<Prompt>, ConnectorFailure>;
  /** Interrupting a call aborts its request, or cancels the task it runs as. */
  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly hooks?: CallHooks;
  }) => Effect.Effect<ToolAnswer, ConnectorFailure>;
  readonly readResource: (input: {
    readonly uri: string;
    readonly hooks?: CallHooks;
  }) => Effect.Effect<ResourceRead, ConnectorFailure>;
  readonly getPrompt: (input: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, string>>;
    readonly hooks?: CallHooks;
  }) => Effect.Effect<PromptText, ConnectorFailure>;
  /**
   * Reads a resource (`resources/read`) for a connector's app, whole, as MCP
   * gives it (`ReadResourceResult`), with the connector's secrets taken out;
   * null when it is larger than `maxBytes` as JSON.
   */
  readonly readAppResource: (
    uri: string,
    maxBytes: number,
  ) => Effect.Effect<Schema.Json | null, ConnectorFailure>;
}

/** Headers the transport sets itself, or that would change how a request is framed: never taken from the store. */
const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** A field value on one line: no CR, LF or NUL, so it can't start another header. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * The request's headers with the credentials added. A header from the store
 * that is reserved, malformed, or would end its line is refused as a whole:
 * the request is not sent, and nothing says what the value was. A header
 * whose name starts `Mcp-Param-` is reserved too: 2026-07-28 has a client
 * mirror a tool's arguments in them.
 */
const signed = (base: RequestInit["headers"], credentials: CallCredentials): Headers => {
  const headers = new Headers(base);
  for (const header of credentials.headers) {
    const name = header.name.toLowerCase();
    const value = Redacted.value(header.value);
    if (
      !HEADER_NAME.test(header.name) ||
      RESERVED_HEADERS.has(name) ||
      name.startsWith("mcp-param-") ||
      !HEADER_VALUE.test(value)
    ) {
      throw new AuthFailing({ reason: "secret-unusable" });
    }
    headers.set(name, value);
  }
  if (Option.isSome(credentials.bearer)) {
    const token = Redacted.value(credentials.bearer.value);
    if (!HEADER_VALUE.test(token)) throw new AuthFailing({ reason: "secret-unusable" });
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
};

/** Runs an effect from the SDK's promise world, throwing its typed failure as it is. */
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.result(effect)).then((result) => {
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  });

/**
 * Whether the server refused the credentials: a `401`, or a `403` whose
 * challenge says the token lacks a scope (MCP 2025-11-25 and 2026-07-28,
 * "insufficient scope"), which a new sign-in with that scope answers.
 */
const refusedCredentials = (response: Response): boolean => {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  const challenge = response.headers.get("www-authenticate") ?? "";
  return /^\s*Bearer\b/i.test(challenge) && /\berror\s*=\s*"?insufficient_scope"?/i.test(challenge);
};

/** What is left of a listing's byte budget, shared by the answers to its pages. */
interface Budget {
  readonly limit: number;
  left: number;
}

/**
 * A request one of the session's effects is making, as the code the SDK
 * calls sees it: the effect's signal, which aborts the request itself when
 * the effect is interrupted or runs out of time; the credentials each
 * attempt was signed with, which its answer is scrubbed of; the budget its
 * answers count against; and, for a call, its hooks.
 */
interface InFlight {
  readonly signal: AbortSignal;
  readonly sent: Array<CallCredentials>;
  readonly budget: Budget | undefined;
  readonly hooks: CallHooks | undefined;
}

const inFlight = new NodeAsyncHooks.AsyncLocalStorage<InFlight>();

/** `response`, failing with {@link ResponseTooLarge} once the answers counted against `budget` pass it. */
const metered = (response: Response, budget: Budget): Response => {
  if (response.body === null) return response;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        budget.left -= chunk.byteLength;
        if (budget.left < 0) controller.error(new ResponseTooLarge({ limit: budget.limit }));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/**
 * A fetch that signs each request with the credentials as they are now. When
 * the server refuses them it reports the refusal, which may renew them, and
 * sends the request once more; a second refusal means the operator must sign
 * in again.
 *
 * A request one of the session's effects makes is aborted when that effect
 * is interrupted or runs out of time. One the SDK sends on its own (the
 * stream a 2026-07-28 server says its lists changed on) has the guard's
 * deadline for its answer to begin.
 */
const signingFetch =
  (
    guarded: GuardedFetch,
    credentials: ConnectorCredentials,
    seen: (sent: CallCredentials) => void,
  ): GuardedFetch =>
  async (input, init) => {
    const flight = inFlight.getStore();
    const own = init?.signal ?? null;
    const signal =
      flight === undefined
        ? own
        : own === null
          ? flight.signal
          : AbortSignal.any([flight.signal, own]);
    const attempt = async () => {
      const current = await run(credentials.current);
      flight?.sent.push(current);
      seen(current);
      const response = await guarded(input, {
        ...init,
        signal,
        headers: signed(init?.headers, current),
      });
      return { response, sent: current };
    };
    const first = await attempt();
    const answered = async (response: Response) =>
      flight?.budget === undefined ? response : metered(response, flight.budget);
    if (!refusedCredentials(first.response)) return answered(first.response);
    await first.response.body?.cancel();
    await run(
      credentials.rejected(
        Option.fromNullishOr(first.response.headers.get("www-authenticate")),
        first.sent,
      ),
    );
    const second = await attempt();
    if (!refusedCredentials(second.response)) return answered(second.response);
    await second.response.body?.cancel();
    if (credentials.refusedAgain !== undefined) {
      await run(
        credentials.refusedAgain(
          Option.fromNullishOr(second.response.headers.get("www-authenticate")),
          second.sent,
        ),
      );
    }
    throw new NeedsSignIn({ renewed: !sameCredentials(first.sent, second.sent) });
  };

const isConnectorFailure = Schema.is(
  Schema.Union([
    NeedsSignIn,
    SecretsUnavailable,
    SecretNeeded,
    StepNotFinished,
    AuthFailing,
    UrlRefused,
    Unreachable,
    ResponseTooLarge,
    TimedOut,
    ServerError,
    NotMcp,
    Withdrawn,
    CommandFailed,
  ]),
);

const isRawRequestClosed = Schema.is(RawRequestClosed);
const isRawRequestError = Schema.is(RawRequestError);

/**
 * What the SDK threw, as one of J3 Bots' failures. Our own errors, thrown from
 * the fetch, come back as they were. Nothing of the SDK's message is kept: it
 * can quote the server's answer.
 */
const failureOf = (error: unknown): ConnectorFailure => {
  if (isConnectorFailure(error)) return error;
  // Version negotiation wraps what the fetch threw.
  const cause = error instanceof Error ? error.cause : undefined;
  if (isConnectorFailure(cause)) return cause;
  if (SdkHttpError.isInstance(error)) return new ServerError({ status: error.status });
  // The connection ended under the request: a server that went away, not one that answered badly.
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.ConnectionClosed) {
    return new Unreachable({ reason: "closed" });
  }
  if (isRawRequestClosed(error)) return new Unreachable({ reason: "closed" });
  if (ProtocolError.isInstance(error) || isRawRequestError(error)) {
    return new ServerError({ status: null });
  }
  return new NotMcp();
};

/** What a request answered, and the credentials it was sent with. */
interface Sent<A> {
  readonly value: A;
  readonly sent: ReadonlyArray<CallCredentials>;
}

/**
 * One request to the server, with a deadline; interrupting it, or running
 * out of time, aborts it. Its answers count against `budget`, when given,
 * and what the server asks while it runs reaches `hooks`.
 */
export const request = <A>(
  deadline: Duration.Duration,
  send: (signal: AbortSignal) => Promise<A>,
  context: { readonly budget?: Budget; readonly hooks?: CallHooks } = {},
): Effect.Effect<Sent<A>, ConnectorFailure> =>
  Effect.tryPromise({
    try: (signal) => {
      const flight: InFlight = {
        signal,
        sent: [],
        budget: context.budget,
        hooks: context.hooks,
      };
      return inFlight
        .run(flight, () => send(signal))
        .then((value) => ({ value, sent: flight.sent }));
    },
    catch: failureOf,
  }).pipe(Effect.timeoutOrElse({ duration: deadline, orElse: () => Effect.fail(new TimedOut()) }));

/** Beyond any deadline here, so the SDK's own timer never fires first. */
export const sdkTimeout = (deadline: Duration.Duration) => Duration.toMillis(deadline) + 60_000;

/** A value shorter than this is not looked for inside other text: it would match ordinary text. */
const MIN_FOUND_INSIDE = 8;

/**
 * A secret shorter than this is not looked for at all: even as a word of its
 * own it would match ordinary text, such as a number.
 */
const MIN_FOUND_AS_WORD = 4;

/**
 * Values of the connector's address that may be a secret: the whole of its
 * path and query, and each query value, as given and as decoded.
 */
const addressValues = (url: URL): ReadonlyArray<string> => [
  `${url.pathname}${url.search}`,
  url.search.slice(1),
  ...url.search
    .slice(1)
    .split("&")
    .flatMap((pair) => pair.split("=").slice(1)),
  ...url.searchParams.values(),
];

/** The values the credentials requests were sent with carry as they are. */
const sentValues = (sent: ReadonlyArray<CallCredentials>): ReadonlyArray<string> =>
  sent.flatMap((credentials) =>
    [
      ...Option.toArray(credentials.bearer),
      ...credentials.headers.map((h) => h.value),
      ...credentials.carried,
    ].map(Redacted.value),
  );

/** The secrets those values were made from. */
const sentSecrets = (sent: ReadonlyArray<CallCredentials>): ReadonlyArray<string> =>
  sent.flatMap((credentials) => credentials.hidden.map(Redacted.value));

const REGEXP_SYNTAX = /[.*+?^${}()|[\]\\]/g;

/** Where `value` stands as a word of its own: no letter, digit or `_` right before or after it. */
const asWord = (value: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_])${value.replace(REGEXP_SYNTAX, "\\$&")}(?![\\p{L}\\p{N}_])`,
    "gu",
  );

/**
 * Replaces, in a server's text, every exact one of `values`, should the
 * server echo one: the credentials a request was sent with, the address'
 * path and query, a command's environment. `secrets` are those known to be
 * secrets, as the operator's secrets a connector's settings name and a
 * gallery form's secret values: taken out as `values` are, and one of
 * {@link MIN_FOUND_AS_WORD} to {@link MIN_FOUND_INSIDE} characters, as a PIN,
 * wherever it stands as a word of its own. Each is also found as a JSON
 * string holds it, since a structured answer is read as JSON. Best effort:
 * a shorter value, a short one inside other text, or one the server changed
 * otherwise (encoded, split, cased), is not found.
 */
export const scrubberOf = (
  values: ReadonlyArray<string>,
  secrets: ReadonlyArray<string> = [],
): ((text: string) => string) => {
  const variants = (value: string) => [value, JSON.stringify(value).slice(1, -1)];
  const inside = new Set(
    [...values, ...secrets].flatMap(variants).filter((value) => value.length >= MIN_FOUND_INSIDE),
  );
  const words = new Set(
    secrets
      .flatMap(variants)
      .filter((value) => value.length >= MIN_FOUND_AS_WORD && value.length < MIN_FOUND_INSIDE),
  );
  const finders = [
    ...[...inside].map((value) => ({
      length: value.length,
      replace: (text: string) => text.replaceAll(value, "[redacted]"),
    })),
    ...[...words].map((value) => {
      const pattern = asWord(value);
      return {
        length: value.length,
        replace: (text: string) => text.replace(pattern, "[redacted]"),
      };
    }),
  ]
    // The longest first, so a value that holds another is taken whole.
    .toSorted((a, b) => b.length - a.length);
  return (text) => finders.reduce((out, finder) => finder.replace(out), text);
};

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const isJsonArray = (value: Schema.JsonArray | Schema.JsonObject): value is Schema.JsonArray =>
  Array.isArray(value);

/** A `blob` that is UTF-8 text, with `scrub` applied to the text; one that is not text is left as it is. */
const scrubbedBlob = (blob: string, scrub: (text: string) => string): string =>
  Option.match(blobText(blob), {
    onNone: () => blob,
    onSome: (text) => {
      const clean = scrub(text);
      return clean === text ? blob : Base64.encode(new TextEncoder().encode(clean));
    },
  });

/**
 * `value` with `scrub` applied to each string and key in it, and to every
 * `blob` of text as its text, which base64 would hide from `scrub`. A number
 * `scrub` would change becomes the string it makes, so the value stays JSON.
 */
const scrubbedJson = (value: Schema.Json, scrub: (text: string) => string): Schema.Json => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return scrub(value);
  if (typeof value === "number") {
    const text = String(value);
    const clean = scrub(text);
    return clean === text ? value : clean;
  }
  if (isJsonArray(value)) return value.map((item) => scrubbedJson(item, scrub));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      scrub(key),
      key === "blob" && typeof item === "string"
        ? scrubbedBlob(scrub(item), scrub)
        : scrubbedJson(item, scrub),
    ]),
  );
};

/**
 * A tool's answer with `scrub` applied to its structured result value by
 * value, before the bot reads it as JSON text: a short secret is found where
 * it stands in a string, which escaping would hide (`PIN:\n4096`).
 */
const scrubbedStructure = (result: CallResult, scrub: (text: string) => string): CallResult => {
  if (result.structuredContent === undefined) return result;
  const decoded = decodeJson(JSON.stringify(result.structuredContent));
  return Option.isNone(decoded)
    ? result
    : { ...result, structuredContent: scrubbedJson(decoded.value, scrub) };
};

/**
 * A server's answer as JSON, with `scrub` applied to what it holds (see
 * {@link scrubbedJson}), for an app: null when it is larger than `maxBytes`.
 */
const appData = (
  value: unknown,
  scrub: (text: string) => string,
  maxBytes: number,
): Schema.Json | null => {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || !fitsUtf8(text, maxBytes)) return null;
  return Option.getOrNull(Option.map(decodeJson(text), (json) => scrubbedJson(json, scrub)));
};

const cut = (text: string, max: number): { readonly text: string; readonly cut: boolean } => {
  const end = codePointsEnd(text, max);
  return end === null ? { text, cut: false } : { text: text.slice(0, end), cut: true };
};

/**
 * The client a session speaks through, with what J3 Bots offers a server:
 * elicitation, in both modes, tasks, and showing a tool's app as an HTML
 * document of the MCP Apps extension (decision 0048). Never sampling or roots.
 */
/**
 * The OAuth client credentials extension (2026-07-28): J3 Bots can sign in to
 * a server as a service, with credentials the operator registered there, so
 * it says so in every request's capabilities.
 */
/** The most steps on its own pages one call's server may ask the operator to finish. */
const MAX_STEPS = 3;

export const CLIENT_CREDENTIALS_EXTENSION = "io.modelcontextprotocol/oauth-client-credentials";

export const makeClient = (
  setup: ClientSetup,
  limits: SessionLimits,
  fork: (effect: Effect.Effect<void>) => void,
): Client => {
  const changed = (kind: ListKind) => ({
    autoRefresh: false,
    debounceMs: 0,
    onChanged: () => fork(setup.onListChanged(kind)),
  });
  return new Client(setup.client, {
    capabilities: {
      elicitation: { form: {}, url: {} },
      extensions: {
        [TASKS_EXTENSION]: {},
        [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
        [CLIENT_CREDENTIALS_EXTENSION]: {},
      },
    },
    versionNegotiation: {
      mode: "auto",
      probe: { timeoutMs: Duration.toMillis(PROBE_TIMEOUT) },
    },
    inputRequired: { autoFulfill: true, maxRounds: MAX_INPUT_ROUNDS },
    listChanged: {
      tools: changed("tools"),
      resources: changed("resources"),
      prompts: changed("prompts"),
    },
    responseCacheStore: setup.cache,
    listMaxPages: limits.maxListPages,
  });
};

/** How long a server may take to answer `server/discover`: over a process's streams, silence past it means an older server. */
const PROBE_TIMEOUT = Duration.seconds(5);

/** The most rounds of questions one call may ask the operator before it fails. */
const MAX_INPUT_ROUNDS = 8;

/** How often a call's progress is passed on, at most. */
const PROGRESS_EVERY = Duration.seconds(1);

/** The most log lines a server's session writes to the server's log in a minute; the rest are dropped. */
const MAX_LOG_LINES_PER_MINUTE = 30;
/** The longest log line kept, in characters. */
const MAX_LOG_CHARACTERS = 500;

/** How often a task is asked how it is doing, unless its server says otherwise, and the bounds on what it says. */
const TASK_POLL = { default: 2_000, min: 500, max: 10_000 };

const decodeResourceContents = Schema.decodeUnknownResult(Schema.Array(ResourceContents));
const decodeCallResult = Schema.decodeUnknownResult(CallResult);
const decodeDetailedTask = Schema.decodeUnknownResult(DetailedTask);
const decodeListed = Schema.decodeUnknownResult(ListedTool);
const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * What a resource's contents say of themselves, as a bot or a client may be
 * shown it: its address and type with the connector's secrets taken out, and
 * its `_meta` only when it holds none of them, since a cleaned one would
 * point nowhere.
 */
const scrubbedAbout = (
  item: ResourceContents,
  clean: (text: string) => string,
): Pick<ResourceContents, "uri" | "mimeType" | "_meta"> => {
  const meta = item._meta;
  const kept =
    meta !== undefined &&
    Option.match(encodeJson(meta), { onNone: () => false, onSome: (text) => clean(text) === text });
  return {
    uri: clean(item.uri),
    ...(item.mimeType === undefined ? {} : { mimeType: clean(item.mimeType) }),
    ...(meta !== undefined && kept ? { _meta: meta } : {}),
  };
};
const decodeMessages = Schema.decodeUnknownResult(
  Schema.Array(
    Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: Schema.Unknown }),
  ),
);

/** What decodes as a listed tool. */
const listedOf = (tools: ReadonlyArray<unknown>): ReadonlyArray<ListedTool> =>
  tools.flatMap((tool) => {
    const decoded = decodeListed(tool);
    return Result.isSuccess(decoded) ? [decoded.success] : [];
  });

/** A server's text as one line the operator or a log reads: cleaned, capped. */
const oneLine = (text: string, max: number): string | null => {
  const line = cleanTitle(text);
  return line === null ? null : line.slice(0, max);
};

/**
 * Opens a session with the connector's server over Streamable HTTP: the
 * guarded connection, the revision negotiated within `listDeadline`. It
 * closes with its scope.
 */
export const openSession = (
  options: SessionOptions,
): Effect.Effect<McpSession, ConnectorFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const { limits } = options;
    const context = yield* Effect.context<never>();
    const fork = (effect: Effect.Effect<void>) => void Effect.runForkWith(context)(effect);
    const guarded = yield* makeGuardedFetch(options.policy, limits.guard);
    /** The credentials the last few requests were sent with, which an answer served from the cache is scrubbed of. */
    const recent: Array<CallCredentials> = [];
    const transport = new StreamableHTTPClientTransport(options.url, {
      fetch: signingFetch(guarded, options.credentials, (sent) => {
        recent.push(sent);
        if (recent.length > 4) recent.shift();
      }),
      redirectPolicy: "same-origin",
      reconnectionOptions: {
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 2,
      },
    });
    const client = makeClient(options, limits, fork);
    yield* Effect.acquireRelease(
      request(limits.listDeadline, (signal) =>
        client.connect(transport, { signal, timeout: sdkTimeout(limits.listDeadline) }),
      ),
      () =>
        Effect.promise(() =>
          transport
            .terminateSession()
            .catch(() => undefined)
            .then(() => client.close())
            .catch(() => undefined),
        ).pipe(Effect.timeoutOrElse({ duration: Duration.seconds(5), orElse: () => Effect.void })),
    );

    const address = addressValues(options.url);
    return sessionOf(client, transport, limits, context, (sent) =>
      scrubberOf(
        [...sentValues([...sent, ...recent]), ...address],
        sentSecrets([...sent, ...recent]),
      ),
    );
  });

/** Calls in flight on a session, which a request for input that names none goes to when there is one. */
type Calls = Set<InFlight>;

/**
 * What a session does once its client is connected, over any transport:
 * list the server's tools, resources and prompts, call a tool, read a
 * resource and get a prompt. `scrub` gives what to take out of the server's
 * text, from the credentials each request was sent with.
 */
export const sessionOf = (
  client: Client,
  transport: Transport,
  limits: SessionLimits,
  context: Context.Context<never>,
  scrub: (sent: ReadonlyArray<CallCredentials>) => (text: string) => string,
): McpSession => {
  const fork = (effect: Effect.Effect<void>) => void Effect.runForkWith(context)(effect);
  const calls: Calls = new Set();
  const callsByTag = new Map<string, InFlight>();
  /** Where each tagged call that asked for its progress takes it. */
  const progressByTag = new Map<string, (step: ProgressStep) => void>();
  const tap: TaskTap = tapTransport(
    transport,
    (tag, deliver) => {
      const flight = callsByTag.get(tag);
      if (flight === undefined) deliver();
      else inFlight.run(flight, deliver);
    },
    (step) => progressByTag.get(step.progressToken)?.(step),
  );

  /**
   * The flight a server's request for input belongs to: the one it arrived
   * within, or else the session's only call in flight. With several and no
   * way to tell which asked (an older server over a process's streams), it
   * is declined.
   */
  const askingFlight = (): InFlight | undefined => {
    const current = inFlight.getStore();
    if (current !== undefined) return current;
    if (calls.size !== 1) return undefined;
    const [only] = calls;
    return only;
  };

  client.setRequestHandler("elicitation/create", async (request, ctx) => {
    const flight = askingFlight();
    const hooks = flight?.hooks;
    if (flight === undefined || hooks === undefined) return { action: "decline" };
    const shown = elicitationOf(request.params);
    if (Result.isFailure(shown)) {
      fork(
        Effect.logInfo("A connector's request for input was declined unseen").pipe(
          Effect.annotateLogs({ reason: shown.failure }),
        ),
      );
      return { action: "decline" };
    }
    // Asked until the server withdraws the request or the call it belongs to ends.
    const answer = await Effect.runPromiseWith(context)(hooks.elicit(shown.success), {
      signal: AbortSignal.any([ctx.mcpReq.signal, flight.signal]),
    });
    return elicitResultOf(answer);
  });

  /**
   * Steps on a server's own pages a call waits for the operator to finish,
   * by the id the server gave each: its `notifications/elicitation/complete`
   * names it when they did.
   */
  const steps = new Map<string, () => void>();
  client.setNotificationHandler("notifications/elicitation/complete", (notification) => {
    steps.get(notification.params.elicitationId)?.();
  });

  let logWindow = { startedAt: 0, lines: 0 };
  client.setNotificationHandler("notifications/message", (notification) =>
    fork(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - logWindow.startedAt > 60_000) logWindow = { startedAt: now, lines: 0 };
        if (++logWindow.lines > MAX_LOG_LINES_PER_MINUTE) return;
        const { level, logger, data } = notification.params;
        const raw = typeof data === "string" ? data : Option.getOrElse(encodeJson(data), () => "");
        const line = oneLine(scrub([])(raw), MAX_LOG_CHARACTERS);
        if (line === null) return;
        yield* Effect.logDebug(`MCP server: ${line}`).pipe(
          Effect.annotateLogs({
            serverLevel: level,
            ...(logger === undefined ? {} : { logger: scrub([])(logger).slice(0, 64) }),
          }),
        );
      }),
    ),
  );

  const capabilities = client.getServerCapabilities();
  const server = client.getServerVersion();
  const info: ServerInfo = {
    protocolVersion: client.getNegotiatedProtocolVersion() ?? "unknown",
    name: server === undefined ? null : cleanTitle(server.name),
    version: server === undefined ? null : cleanTitle(server.version),
    offers: {
      tools: capabilities?.tools !== undefined,
      resources: capabilities?.resources !== undefined,
      prompts: capabilities?.prompts !== undefined,
      tasks: capabilities?.extensions?.[TASKS_EXTENSION] !== undefined,
    },
  };

  /** One listing, counted against its budget, within the list deadline. */
  const listing = <A>(send: (signal: AbortSignal) => Promise<A>) =>
    request(limits.listDeadline, send, {
      budget: { limit: limits.maxCatalogBytes, left: limits.maxCatalogBytes },
    });
  const listOptions = (signal: AbortSignal) => ({
    signal,
    timeout: sdkTimeout(limits.listDeadline),
  });
  const withinBudget = <A>(entries: ReadonlyArray<A>, bytes: (entry: A) => number) =>
    entries.reduce((sum, entry) => sum + bytes(entry), 0) > limits.maxCatalogBytes
      ? Effect.fail(new ResponseTooLarge({ limit: limits.maxCatalogBytes }))
      : Effect.succeed(entries);

  const listTools = Effect.gen(function* () {
    if (!info.offers.tools) return [];
    const answer = yield* listing((signal) => client.listTools(undefined, listOptions(signal)));
    const tools = catalogOf(listedOf(answer.value.tools), { redact: scrub(answer.sent) });
    return yield* withinBudget(tools, toolBytes);
  });

  const listResources = Effect.gen(function* () {
    if (!info.offers.resources) return [];
    const resources = yield* listing((signal) =>
      client.listResources(undefined, listOptions(signal)),
    );
    const templates = yield* listing((signal) =>
      client.listResourceTemplates(undefined, listOptions(signal)),
    );
    const listed = resourcesOf(
      resources.value.resources,
      templates.value.resourceTemplates,
      scrub([...resources.sent, ...templates.sent]),
    );
    return yield* withinBudget(listed, entryBytes);
  });

  const listPrompts = Effect.gen(function* () {
    if (!info.offers.prompts) return [];
    const answer = yield* listing((signal) => client.listPrompts(undefined, listOptions(signal)));
    return yield* withinBudget(promptsOf(answer.value.prompts, scrub(answer.sent)), entryBytes);
  });

  /**
   * Passes a call's progress to its hooks, one step after another, at most
   * every {@link PROGRESS_EVERY}: its last step always goes.
   */
  const progressTo = (hooks: CallHooks | undefined) => {
    let last = Number.NEGATIVE_INFINITY;
    return Effect.fn("McpSession.progress")(function* (progress: CallProgress) {
      if (hooks === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      if (now - last < Duration.toMillis(PROGRESS_EVERY) && progress.fraction !== 1) return;
      last = now;
      yield* hooks.progress(progress);
    });
  };

  /**
   * Where a call's progress goes as the tap sees it arrive, outside any
   * fiber: a queue its hooks are given from, in order. `delivered` waits
   * until every step offered so far reached them, so the call answers after
   * its progress.
   */
  const progressQueue = Effect.fn("McpSession.progressQueue")(function* (
    hooks: CallHooks | undefined,
  ) {
    const queue = yield* Queue.unbounded<CallProgress, Cause.Done>();
    const delivering = yield* Stream.fromQueue(queue).pipe(
      Stream.runForEach(progressTo(hooks)),
      Effect.forkChild,
    );
    return {
      offer: (progress: CallProgress) => void Queue.offerUnsafe(queue, progress),
      delivered: Queue.end(queue).pipe(Effect.andThen(Fiber.join(delivering))),
    };
  });

  /**
   * Runs `send` as a tagged call: the flight is known by its tag, so an
   * answer to it reaches its hooks however it arrives, and it counts as in
   * flight while it runs.
   */
  const tagged = <A>(
    deadline: Duration.Duration,
    hooks: CallHooks | undefined,
    send: (tag: string, signal: AbortSignal) => Promise<A>,
    progress?: (step: ProgressStep) => void,
  ) => {
    const tag = NodeCrypto.randomUUID();
    return request(
      deadline,
      (signal) => {
        const flight = inFlight.getStore();
        if (flight !== undefined) {
          calls.add(flight);
          callsByTag.set(tag, flight);
        }
        if (progress !== undefined) progressByTag.set(tag, progress);
        return send(tag, signal).finally(() => {
          if (flight !== undefined) calls.delete(flight);
          callsByTag.delete(tag);
          progressByTag.delete(tag);
          tap.forget(tag);
        });
      },
      hooks === undefined ? {} : { hooks },
    );
  };

  const taskRequest = (
    method: "tasks/get" | "tasks/update" | "tasks/cancel",
    params: Readonly<Record<string, unknown>>,
  ) => request(limits.listDeadline, (signal) => tap.request(method, params, signal));

  /**
   * Follows a call its server runs as a task until it ends: asks how it is
   * doing as often as it says, passes its status on as progress, puts its
   * questions to the operator, and gives its result. Interrupting it, or
   * running out of `left`, what the task deadline leaves of the call,
   * cancels the task at the server.
   */
  const followTask = Effect.fn("McpSession.followTask")(function* (
    task: Task,
    hooks: CallHooks | undefined,
    left: Duration.Duration,
  ) {
    const report = progressTo(hooks);
    const answered = new Set<string>();
    const pollMs = (t: Task) =>
      Math.min(TASK_POLL.max, Math.max(TASK_POLL.min, t.pollIntervalMs ?? TASK_POLL.default));
    const loop = Effect.gen(function* () {
      let current: DetailedTask = task;
      for (;;) {
        if (current.statusMessage !== undefined) {
          yield* report({
            message: oneLine(scrub([])(current.statusMessage), 200),
            fraction: null,
          });
        }
        switch (current.status) {
          case "completed": {
            if (current.result !== undefined) {
              const decoded = decodeCallResult(current.result);
              if (Result.isFailure(decoded)) return yield* new NotMcp();
              return decoded.success;
            }
            break;
          }
          case "failed":
          case "cancelled":
            return yield* new ServerError({ status: null });
          case "input_required": {
            const waiting = Object.entries(current.inputRequests ?? {}).filter(
              ([key]) => !answered.has(key),
            );
            if (waiting.length > 0) {
              const responses: Record<string, unknown> = {};
              for (const [key, input] of waiting) {
                if (input.method !== "elicitation/create") {
                  return yield* new ServerError({ status: null });
                }
                responses[key] = yield* answerInput(input.params, hooks);
                answered.add(key);
              }
              yield* taskRequest("tasks/update", {
                taskId: task.taskId,
                inputResponses: responses,
              });
            }
            break;
          }
          case "working":
            break;
        }
        yield* Effect.sleep(Duration.millis(pollMs(current)));
        const got = yield* taskRequest("tasks/get", { taskId: task.taskId });
        const decoded = decodeDetailedTask(got.value);
        if (Result.isFailure(decoded) || decoded.success.taskId !== task.taskId) {
          return yield* new NotMcp();
        }
        current = decoded.success;
      }
    });
    const cancel = taskRequest("tasks/cancel", { taskId: task.taskId }).pipe(
      Effect.timeoutOrElse({ duration: Duration.seconds(5), orElse: () => Effect.void }),
      Effect.ignore,
    );
    return yield* loop.pipe(
      Effect.onInterrupt(() => cancel),
      Effect.timeoutOrElse({
        duration: left,
        orElse: () => Effect.fail(new TimedOut()),
      }),
    );
  });

  /** The operator's answer to one of a task's requests for input, as the server reads it; declined when no one can answer. */
  const answerInput = Effect.fn("McpSession.answerInput")(function* (
    params: unknown,
    hooks: CallHooks | undefined,
  ) {
    if (hooks === undefined) return { action: "decline" } as const;
    const shown = elicitationOf(params);
    if (Result.isFailure(shown)) return { action: "decline" } as const;
    return elicitResultOf(yield* hooks.elicit(shown.success));
  });

  /**
   * Puts each step a server needs finished on a page of its own (`-32042`)
   * to the operator, as a request for input, and waits until the server says
   * they finished it: for at most `left` in all, the card's answer included,
   * whose card closes when it runs out. A step that is not a page J3 Bots
   * shows, or one the operator does not open, ends the call.
   */
  const finishSteps = Effect.fn("McpSession.finishSteps")(function* (
    asked: UrlElicitationRequiredError["elicitations"],
    hooks: CallHooks | undefined,
    left: Duration.Duration,
  ) {
    if (hooks === undefined || asked.length === 0 || asked.length > MAX_STEPS) {
      return yield* new StepNotFinished({ outcome: "declined" });
    }
    yield* Effect.gen(function* () {
      for (const step of asked) {
        yield* finishStep(step, hooks);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: left,
        orElse: () => Effect.fail(new StepNotFinished({ outcome: "unfinished" })),
      }),
    );
  });

  /** One step of `finishSteps`: shown, opened, then finished on the server's page. */
  const finishStep = Effect.fn("McpSession.finishStep")(function* (
    step: UrlElicitationRequiredError["elicitations"][number],
    hooks: CallHooks,
  ) {
    const shown = elicitationOf(step);
    if (Result.isFailure(shown)) {
      yield* Effect.logInfo("A connector's step on a page of its own was declined unseen").pipe(
        Effect.annotateLogs({ reason: shown.failure }),
      );
      return yield* new StepNotFinished({ outcome: "declined" });
    }
    // Listened for before it is shown: the server may say it is done at once.
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    steps.set(step.elicitationId, finish);
    yield* Effect.gen(function* () {
      const answer = yield* hooks.elicit(shown.success);
      if (answer._tag !== "accept") return yield* new StepNotFinished({ outcome: "declined" });
      yield* Effect.promise(() => finished);
    }).pipe(Effect.ensuring(Effect.sync(() => steps.delete(step.elicitationId))));
  });

  const callTool: McpSession["callTool"] = (input) =>
    callOnce(input, { deadline: limits.callDeadline, mayAskSteps: true });

  /**
   * One attempt at a call, within `deadline`. After the operator finished the
   * steps a server asked for, it goes again once, within what is left.
   */
  const callOnce: (
    input: Parameters<McpSession["callTool"]>[0],
    attempt: { readonly deadline: Duration.Duration; readonly mayAskSteps: boolean },
  ) => ReturnType<McpSession["callTool"]> = Effect.fn("McpSession.callTool")(function* (
    input: Parameters<McpSession["callTool"]>[0],
    attempt: { readonly deadline: Duration.Duration; readonly mayAskSteps: boolean },
  ) {
    const progress = yield* progressQueue(input.hooks);
    const began = yield* Clock.currentTimeMillis;
    const answer = yield* tagged(
      attempt.deadline,
      input.hooks,
      (tag, signal) =>
        client
          .callTool(
            {
              name: input.name,
              arguments: { ...input.arguments },
              // The call's progress is asked for under its tag, which the tap passes on.
              _meta: {
                [CALL_TAG]: tag,
                ...(input.hooks === undefined ? {} : { progressToken: tag }),
              },
            },
            { signal, timeout: sdkTimeout(attempt.deadline) },
          )
          .then(
            (result) => ({ _tag: "answer", result }) as const,
            (error: unknown) => {
              const task = tap.taken(tag);
              if (
                task !== undefined &&
                SdkError.isInstance(error) &&
                error.code === SdkErrorCode.UnsupportedResultType
              ) {
                return { _tag: "task", task } as const;
              }
              if (UrlElicitationRequiredError.isInstance(error)) {
                return { _tag: "steps", asked: error.elicitations } as const;
              }
              throw error;
            },
          ),
      (step) =>
        progress.offer({
          message: step.message === undefined ? null : oneLine(scrub([])(step.message), 200),
          fraction:
            step.total === undefined || step.total <= 0
              ? null
              : Math.min(1, Math.max(0, step.progress / step.total)),
        }),
    );
    yield* progress.delivered;
    if (answer.value._tag === "steps") {
      // Asked once: a server that needs another step after the operator finished one is not answering.
      if (!attempt.mayAskSteps) return yield* new StepNotFinished({ outcome: "unfinished" });
      const left = (spent: number) =>
        Duration.millis(Math.max(0, Duration.toMillis(attempt.deadline) - spent));
      yield* finishSteps(
        answer.value.asked,
        input.hooks,
        left((yield* Clock.currentTimeMillis) - began),
      );
      return yield* callOnce(input, {
        deadline: left((yield* Clock.currentTimeMillis) - began),
        mayAskSteps: false,
      });
    }
    const result =
      answer.value._tag === "task"
        ? yield* followTask(
            answer.value.task,
            input.hooks,
            // The hour counts from the call, so the `j3` bridge's wait covers it all.
            Duration.millis(
              Math.max(
                0,
                Duration.toMillis(limits.taskDeadline) - ((yield* Clock.currentTimeMillis) - began),
              ),
            ),
          )
        : yield* decodeCallResult(answer.value.result).pipe(
            Effect.fromResult,
            Effect.mapError(() => new NotMcp()),
          );
    const clean = scrub(answer.sent);
    const text = cut(
      clean(answerText(scrubbedStructure(result, clean))),
      limits.maxResultCharacters,
    );
    return {
      text: text.text,
      cut: text.cut,
      isError: result.isError === true,
      result: appData(result, clean, MAX_CONNECTOR_APP_DATA_BYTES),
    };
  });

  const readResource: McpSession["readResource"] = Effect.fn("McpSession.readResource")(
    function* (input) {
      const answer = yield* tagged(limits.callDeadline, input.hooks, (tag, signal) =>
        client.readResource(
          { uri: input.uri, _meta: { [CALL_TAG]: tag } },
          { signal, timeout: sdkTimeout(limits.callDeadline) },
        ),
      );
      const decoded = decodeResourceContents(answer.value.contents);
      if (Result.isFailure(decoded)) return yield* new NotMcp();
      const clean = scrub(answer.sent);
      let left = limits.maxResultCharacters;
      let wasCut = false;
      const contents: Array<ResourceContents> = [];
      for (const item of decoded.success) {
        const size = "text" in item ? item.text.length : item.blob.length;
        if (left <= 0 || ("blob" in item && size > left)) {
          wasCut = true;
          continue;
        }
        if ("text" in item) {
          const text = cut(clean(item.text), left);
          wasCut ||= text.cut;
          left -= text.text.length;
          contents.push({ ...scrubbedAbout(item, clean), text: text.text });
        } else {
          left -= size;
          contents.push({ ...scrubbedAbout(item, clean), blob: item.blob });
        }
      }
      return { contents, cut: wasCut };
    },
  );

  const getPrompt: McpSession["getPrompt"] = Effect.fn("McpSession.getPrompt")(function* (input) {
    const answer = yield* tagged(limits.callDeadline, input.hooks, (tag, signal) =>
      client.getPrompt(
        { name: input.name, arguments: { ...input.arguments }, _meta: { [CALL_TAG]: tag } },
        { signal, timeout: sdkTimeout(limits.callDeadline) },
      ),
    );
    const decoded = decodeMessages(answer.value.messages);
    if (Result.isFailure(decoded)) return yield* new NotMcp();
    const clean = scrub(answer.sent);
    let left = limits.maxResultCharacters;
    let wasCut = false;
    const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (const message of decoded.success) {
      const text = cut(clean(contentText(message.content)), Math.max(0, left));
      wasCut ||= text.cut;
      left -= text.text.length;
      messages.push({ role: message.role, text: text.text });
    }
    const description =
      answer.value.description === undefined ? null : oneLine(clean(answer.value.description), 500);
    return { description, messages, cut: wasCut };
  });

  const readAppResource: McpSession["readAppResource"] = Effect.fn("McpSession.readAppResource")(
    function* (uri, maxBytes) {
      const answer = yield* tagged(limits.listDeadline, undefined, (tag, signal) =>
        client.readResource(
          { uri, _meta: { [CALL_TAG]: tag } },
          { signal, timeout: sdkTimeout(limits.listDeadline) },
        ),
      );
      return appData(answer.value, scrub(answer.sent), maxBytes);
    },
  );

  return {
    info,
    listTools,
    listResources,
    listPrompts,
    callTool,
    readResource,
    readAppResource,
    getPrompt,
  };
};
