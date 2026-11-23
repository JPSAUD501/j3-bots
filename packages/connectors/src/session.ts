// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type CallToolResult,
  Client,
  ProtocolError,
  SdkError,
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
import { ListedTool } from "./catalog.ts";
import {
  AuthFailing,
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
} from "./errors.ts";
import {
  DEFAULT_GUARD,
  type GuardedFetch,
  type GuardOptions,
  makeGuardedFetch,
  type UrlPolicy,
} from "./guard.ts";

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
   * `WWW-Authenticate`: renew them (a refresh) or fail. The request is sent
   * once more with what `current` gives next.
   */
  readonly rejected: (
    wwwAuthenticate: Option.Option<string>,
  ) => Effect.Effect<void, CredentialsUnavailable>;
}

export interface SessionLimits {
  /** How long opening the session, or listing tools, may take. */
  readonly listDeadline: Duration.Duration;
  /** How long one tool call may take. */
  readonly callDeadline: Duration.Duration;
  /** The most characters of a tool's answer a bot reads; the rest is cut. */
  readonly maxResultCharacters: number;
  readonly guard: GuardOptions;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  listDeadline: Duration.seconds(30),
  callDeadline: Duration.minutes(10),
  maxResultCharacters: 100_000,
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
  readonly listTools: Effect.Effect<ReadonlyArray<ListedTool>, ConnectorFailure>;
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
 * A fetch that signs each request with the credentials as they are now. On a
 * 401 it reports the refusal, which may renew them, and sends the request
 * once more; a second 401 means the operator must sign in again.
 */
const signingFetch =
  (guarded: GuardedFetch, credentials: ConnectorCredentials): GuardedFetch =>
  async (input, init) => {
    const attempt = async () =>
      guarded(input, { ...init, headers: signed(init?.headers, await run(credentials.current)) });
    const first = await attempt();
    if (first.status !== 401) return first;
    await first.body?.cancel();
    await run(credentials.rejected(Option.fromNullishOr(first.headers.get("www-authenticate"))));
    const second = await attempt();
    if (second.status !== 401) return second;
    await second.body?.cancel();
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
  if (ProtocolError.isInstance(error)) return new ServerError({ status: null });
  if (SdkError.isInstance(error)) return new NotMcp();
  return new NotMcp();
};

/** One request to the server, with a deadline; interrupting it aborts the request. */
const request = <A>(
  deadline: Duration.Duration,
  send: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ConnectorFailure> =>
  Effect.tryPromise({ try: send, catch: failureOf }).pipe(
    Effect.timeoutOrElse({ duration: deadline, orElse: () => Effect.fail(new TimedOut()) }),
  );

/** Beyond any deadline here, so the SDK's own timer never fires first. */
const sdkTimeout = (deadline: Duration.Duration) => Duration.toMillis(deadline) + 60_000;

const decodeListed = Schema.decodeUnknownResult(ListedTool);

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

/** Secrets shorter than this are not searched for: they would match ordinary text. */
const MIN_SCRUBBED = 8;

/** The text with every value of the connector's credentials replaced, in case the server echoed one. */
const scrub = (text: string, credentials: CallCredentials): string => {
  const secrets = [
    ...Option.toArray(credentials.bearer),
    ...credentials.headers.map((header) => header.value),
  ]
    .map(Redacted.value)
    .filter((value) => value.length >= MIN_SCRUBBED);
  return secrets.reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text);
};

const cut = (text: string, max: number): { readonly text: string; readonly cut: boolean } => {
  const characters = Array.from(text);
  return characters.length <= max
    ? { text, cut: false }
    : { text: characters.slice(0, max).join(""), cut: true };
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

    const listTools = request(limits.listDeadline, (signal) =>
      client.listTools(undefined, { signal, timeout: sdkTimeout(limits.listDeadline) }),
    ).pipe(
      Effect.map(({ tools }) =>
        tools.flatMap((tool) => {
          const decoded = decodeListed(tool);
          return Result.isSuccess(decoded) ? [decoded.success] : [];
        }),
      ),
    );

    const callTool: McpSession["callTool"] = Effect.fn("McpSession.callTool")(function* (input) {
      const result = yield* request(limits.callDeadline, (signal) =>
        client.callTool(
          { name: input.name, arguments: { ...input.arguments } },
          { signal, timeout: sdkTimeout(limits.callDeadline) },
        ),
      );
      // Read again rather than kept from the call: nothing holds a secret between requests.
      const credentials = yield* options.credentials.current;
      const text = cut(scrub(answerText(result), credentials), limits.maxResultCharacters);
      return { text: text.text, cut: text.cut, isError: result.isError === true };
    });

    return { listTools, callTool } satisfies McpSession;
  });
