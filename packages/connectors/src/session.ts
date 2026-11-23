// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Which effect a fetch from inside the SDK belongs to is known only through node:async_hooks.
import * as NodeAsyncHooks from "node:async_hooks";
import {
  type CallToolResult,
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { type CatalogTool, catalogOf, ListedTool, toolBytes } from "./catalog.ts";
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
  VaultLocked,
  Withdrawn,
} from "./errors.ts";
import {
  DEFAULT_GUARD,
  type GuardedFetch,
  type GuardOptions,
  makeGuardedFetch,
  type UrlPolicy,
} from "./guard.ts";
import { codePointsEnd } from "./text.ts";

/**
 * One MCP session with a connector's server, over Streamable HTTP, for one
 * bot (`docs/architecture/server.md`, "Connectors"). A session can hold state
 * at its server (a current page, a cursor), so bots never share one.
 *
 * Its credentials are read from their store for every request and added
 * then; nothing here keeps a token or a header's value between requests.
 */

/** A header J3 Bots adds to each request, with its value from the store. */
export interface SecretHeader {
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
}

/** What signs one request: a bearer token from a sign-in, and headers the operator gave. */
export interface CallCredentials {
  readonly bearer: Option.Option<Redacted.Redacted<string>>;
  readonly headers: ReadonlyArray<SecretHeader>;
}

/** Where a session reads its credentials, at each request. */
export interface ConnectorCredentials {
  readonly current: Effect.Effect<CallCredentials, CredentialsUnavailable>;
  /**
   * The server refused the credentials just sent, with this
   * `WWW-Authenticate`: renew them (a refresh) or fail. `sent` is the bearer
   * token that request carried, so a token renewed meanwhile by another
   * request is not renewed again. The request is sent once more with what
   * `current` gives next.
   */
  readonly rejected: (
    wwwAuthenticate: Option.Option<string>,
    sent: Option.Option<Redacted.Redacted<string>>,
  ) => Effect.Effect<void, CredentialsUnavailable>;
}

export interface SessionLimits {
  /** How long opening the session, or listing every page of its tools, may take. */
  readonly listDeadline: Duration.Duration;
  /** How long one tool call may take. */
  readonly callDeadline: Duration.Duration;
  /** The most characters of a tool's answer a bot reads; the rest is cut. */
  readonly maxResultCharacters: number;
  /** The most a listing's tools may take, in bytes, across its pages, once cleaned: past it, the listing fails. */
  readonly maxCatalogBytes: number;
  /** The most pages a listing may take. */
  readonly maxListPages: number;
  readonly guard: GuardOptions;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  listDeadline: Duration.seconds(30),
  callDeadline: Duration.minutes(10),
  maxResultCharacters: 100_000,
  maxCatalogBytes: 8 * 1024 * 1024,
  maxListPages: 64,
  guard: DEFAULT_GUARD,
};

export interface SessionOptions {
  readonly url: URL;
  readonly policy: UrlPolicy;
  readonly credentials: ConnectorCredentials;
  readonly limits: SessionLimits;
  /** How J3 Bots names itself to the server. */
  readonly client: { readonly name: string; readonly version: string };
  /** The server said its tools changed (`notifications/tools/list_changed`). */
  readonly onToolsChanged: Effect.Effect<void>;
}

/** What a tool answered, as a bot may read it: cut to size, with the connector's secrets taken out. */
export interface ToolAnswer {
  readonly text: string;
  readonly isError: boolean;
  /** Part of the answer was cut to fit `maxResultCharacters`. */
  readonly cut: boolean;
}

export interface McpSession {
  /** Every tool its server lists, cleaned, with the connector's secrets taken out. */
  readonly listTools: Effect.Effect<ReadonlyArray<CatalogTool>, ConnectorFailure>;
  /** Interrupting a call aborts its request. */
  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }) => Effect.Effect<ToolAnswer, ConnectorFailure>;
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
 * the request is not sent, and nothing says what the value was.
 */
const signed = (base: RequestInit["headers"], credentials: CallCredentials): Headers => {
  const headers = new Headers(base);
  for (const header of credentials.headers) {
    const name = header.name.toLowerCase();
    const value = Redacted.value(header.value);
    if (!HEADER_NAME.test(header.name) || RESERVED_HEADERS.has(name) || !HEADER_VALUE.test(value)) {
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
 * challenge says the token lacks a scope (MCP 2025-11-25, "Runtime
 * insufficient scope errors"), which a new sign-in with that scope answers.
 */
const refusedCredentials = (response: Response): boolean => {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  const challenge = response.headers.get("www-authenticate") ?? "";
  return /^\s*Bearer\b/i.test(challenge) && /\berror\s*=\s*"?insufficient_scope"?/i.test(challenge);
};

/**
 * A request one of the session's effects is making, as the fetch the SDK
 * calls sees it: the effect's signal, which aborts the request itself when
 * the effect is interrupted or runs out of time, and the credentials each
 * attempt was signed with, which its answer is scrubbed of.
 */
interface InFlight {
  readonly signal: AbortSignal;
  readonly sent: Array<CallCredentials>;
}

const inFlight = new NodeAsyncHooks.AsyncLocalStorage<InFlight>();

/**
 * A fetch that signs each request with the credentials as they are now. When
 * the server refuses them it reports the refusal, which may renew them, and
 * sends the request once more; a second refusal means the operator must sign
 * in again.
 *
 * A request one of the session's effects makes is aborted when that effect
 * is interrupted or runs out of time. One the SDK sends on its own has the
 * guard's deadline for its answer.
 */
const signingFetch =
  (guarded: GuardedFetch, credentials: ConnectorCredentials): GuardedFetch =>
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
      const response = await guarded(input, {
        ...init,
        signal,
        headers: signed(init?.headers, current),
      });
      return { response, bearer: current.bearer };
    };
    const first = await attempt();
    if (!refusedCredentials(first.response)) return first.response;
    await first.response.body?.cancel();
    await run(
      credentials.rejected(
        Option.fromNullishOr(first.response.headers.get("www-authenticate")),
        first.bearer,
      ),
    );
    const second = await attempt();
    if (!refusedCredentials(second.response)) return second.response;
    await second.response.body?.cancel();
    throw new NeedsSignIn();
  };

const isConnectorFailure = Schema.is(
  Schema.Union([
    NeedsSignIn,
    VaultLocked,
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

/**
 * What the SDK threw, as one of J3 Bots' failures. Our own errors, thrown from
 * the fetch, come back as they were. Nothing of the SDK's message is kept: it
 * can quote the server's answer.
 */
const failureOf = (error: unknown): ConnectorFailure => {
  if (isConnectorFailure(error)) return error;
  if (SdkHttpError.isInstance(error)) return new ServerError({ status: error.status });
  // The connection ended under the request: a server that went away, not one that answered badly.
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.ConnectionClosed) {
    return new Unreachable({ reason: "closed" });
  }
  if (ProtocolError.isInstance(error)) return new ServerError({ status: null });
  if (SdkError.isInstance(error)) return new NotMcp();
  return new NotMcp();
};

/** What a request answered, and the credentials it was sent with. */
interface Sent<A> {
  readonly value: A;
  readonly sent: ReadonlyArray<CallCredentials>;
}

/** One request to the server, with a deadline; interrupting it, or running out of time, aborts it. */
export const request = <A>(
  deadline: Duration.Duration,
  send: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<Sent<A>, ConnectorFailure> =>
  Effect.tryPromise({
    try: (signal) => {
      const flight: InFlight = { signal, sent: [] };
      return inFlight
        .run(flight, () => send(signal))
        .then((value) => ({ value, sent: flight.sent }));
    },
    catch: failureOf,
  }).pipe(Effect.timeoutOrElse({ duration: deadline, orElse: () => Effect.fail(new TimedOut()) }));

/** Beyond any deadline here, so the SDK's own timer never fires first. */
export const sdkTimeout = (deadline: Duration.Duration) => Duration.toMillis(deadline) + 60_000;

const decodeListed = Schema.decodeUnknownResult(ListedTool);

/** What decodes as a listed tool, from one page. */
const listedOf = (tools: ReadonlyArray<unknown>): ReadonlyArray<ListedTool> =>
  tools.flatMap((tool) => {
    const decoded = decodeListed(tool);
    return Result.isSuccess(decoded) ? [decoded.success] : [];
  });

/** A tool's answer as text: binary parts are named, not inlined. */
const answerText = (result: CallToolResult): string => {
  const parts = result.content.map((block) => {
    switch (block.type) {
      case "text":
        return block.text;
      case "image":
      case "audio":
        return `[${block.type}: ${block.mimeType}, not shown]`;
      case "resource_link":
        return `[link: ${block.name} ${block.uri}]`;
      case "resource":
        return "text" in block.resource
          ? block.resource.text
          : `[file: ${block.resource.mimeType ?? "unknown type"} ${block.resource.uri}, not shown]`;
      default:
        return "[content of a kind J3 Bots does not read]";
    }
  });
  if (parts.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent) ?? "";
  }
  return parts.join("\n\n");
};

/** Values shorter than this are not searched for: they would match ordinary text. */
const MIN_SCRUBBED = 8;

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

/** The values of the credentials requests were sent with. */
const sentValues = (sent: ReadonlyArray<CallCredentials>): ReadonlyArray<string> =>
  sent.flatMap((credentials) =>
    [...Option.toArray(credentials.bearer), ...credentials.headers.map((h) => h.value)].map(
      Redacted.value,
    ),
  );

/**
 * Replaces, in a server's text, every exact one of `values`, should the
 * server echo one: the credentials a request was sent with, the address'
 * path and query, a command's environment. Each is also found as a JSON
 * string holds it, since a structured answer is read as JSON. Best effort: a
 * value shorter than {@link MIN_SCRUBBED}, or one the server changed
 * otherwise (encoded, split, cased), is not found.
 */
export const scrubberOf = (values: ReadonlyArray<string>): ((text: string) => string) => {
  const secrets = [...new Set(values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))]
    .filter((value) => value.length >= MIN_SCRUBBED)
    // The longest first, so a value that holds another is taken whole.
    .toSorted((a, b) => b.length - a.length);
  return (text) => secrets.reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text);
};

const cut = (text: string, max: number): { readonly text: string; readonly cut: boolean } => {
  const end = codePointsEnd(text, max);
  return end === null ? { text, cut: false } : { text: text.slice(0, end), cut: true };
};

/**
 * Opens a session with the connector's server: the guarded connection, the
 * MCP handshake within `listDeadline`. It closes with its scope, ending the
 * session at the server when the server allows.
 */
export const openSession = (
  options: SessionOptions,
): Effect.Effect<McpSession, ConnectorFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const { limits } = options;
    const fork = Effect.runForkWith(yield* Effect.context<never>());
    const guarded = yield* makeGuardedFetch(options.policy, limits.guard);
    const transport = new StreamableHTTPClientTransport(options.url, {
      fetch: signingFetch(guarded, options.credentials),
      redirectPolicy: "same-origin",
      reconnectionOptions: {
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 2,
      },
    });
    const client = new Client(options.client, {
      capabilities: {},
      listChanged: {
        tools: {
          autoRefresh: false,
          debounceMs: 0,
          onChanged: () => fork(options.onToolsChanged),
        },
      },
    });
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
    return toolsOf(client, limits, (sent) => scrubberOf([...sentValues(sent), ...address]));
  });

/**
 * What a session does once its client is connected, over any transport:
 * list the server's tools and call one. `scrub` gives what to take out of
 * the server's text, from the credentials each request was sent with.
 */
export const toolsOf = (
  client: Client,
  limits: SessionLimits,
  scrub: (sent: ReadonlyArray<CallCredentials>) => (text: string) => string,
): McpSession => {
  /**
   * Every page of the server's tools, each cleaned as it comes so a listing
   * holds no more than {@link SessionLimits.maxCatalogBytes} of them: a
   * server that lists more, or more than `maxListPages` pages, fails it.
   */
  const listTools = Effect.gen(function* () {
    if (client.getServerCapabilities()?.tools === undefined) return [];
    const tooLarge = new ResponseTooLarge({ limit: limits.maxCatalogBytes });
    let tools: ReadonlyArray<CatalogTool> = [];
    let bytes = 0;
    let cursor: string | undefined;
    for (let pages = 0; pages < limits.maxListPages; pages++) {
      const page = cursor === undefined ? {} : { params: { cursor } };
      const answer = yield* request(limits.listDeadline, (signal) =>
        client.request(
          { method: "tools/list", ...page },
          { signal, timeout: sdkTimeout(limits.listDeadline) },
        ),
      );
      const before = tools.length;
      tools = catalogOf(listedOf(answer.value.tools), {
        earlier: tools,
        redact: scrub(answer.sent),
      });
      for (const tool of tools.slice(before)) bytes += toolBytes(tool);
      if (bytes > limits.maxCatalogBytes) return yield* tooLarge;
      cursor = answer.value.nextCursor;
      if (cursor === undefined) return tools;
    }
    return yield* tooLarge;
  }).pipe(
    Effect.timeoutOrElse({
      duration: limits.listDeadline,
      orElse: () => Effect.fail(new TimedOut()),
    }),
  );

  const callTool: McpSession["callTool"] = Effect.fn("McpSession.callTool")(function* (input) {
    const answer = yield* request(limits.callDeadline, (signal) =>
      client.callTool(
        { name: input.name, arguments: { ...input.arguments } },
        { signal, timeout: sdkTimeout(limits.callDeadline) },
      ),
    );
    const text = cut(scrub(answer.sent)(answerText(answer.value)), limits.maxResultCharacters);
    return { text: text.text, cut: text.cut, isError: answer.value.isError === true };
  });

  return { listTools, callTool };
};
