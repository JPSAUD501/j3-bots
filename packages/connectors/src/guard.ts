// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- Pinning a connection to the address that was checked needs node:http's lookup hook, which fetch does not offer.
import * as NodeDns from "node:dns";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import {
  isAddressLiteral,
  isLoopbackAddress,
  isPrivateNetworkAddress,
  isPublicAddress,
} from "./address.ts";
import { ResponseTooLarge, Unreachable, UrlRefused } from "./errors.ts";

/**
 * The guard every request to a connector's server goes through
 * (`docs/architecture/security.md`, "Connectors"). It stands between J3 Bots
 * and URLs that someone other than J3 Bots chose: the operator's connector
 * address, and the addresses a remote server names during sign-in.
 *
 * - Only `https:`, except plain HTTP to this machine's loopback when the policy
 *   allows it, for a server J3 Bots started by command.
 * - No user name or password in a URL.
 * - The host's addresses are resolved here, at connect time, and the
 *   connection goes to an address that was checked. A name that resolves to a
 *   private, loopback, link-local or reserved address is refused, so a name
 *   that changes what it resolves to between two lookups (DNS rebinding)
 *   cannot reach the operator's network.
 * - A redirect is never followed here. The policy either refuses it or hands
 *   it back to the caller, whose next request comes through the guard again.
 * - An answer is read only up to a size limit.
 */

export interface UrlPolicy {
  /** `allow-http`: a server J3 Bots started by command, which listens on this machine's loopback. */
  readonly loopback: "refuse" | "allow-http";
  /**
   * `allow`: a connector whose address the operator confirmed is in their own
   * network, which may then resolve to a private or unique-local address
   * (never loopback, link-local or reserved). Sign-in requests never allow it.
   */
  readonly privateNetwork: "refuse" | "allow";
  /** `recheck`: a redirect is answered as it is, and following it is a new, checked request. */
  readonly redirects: "refuse" | "recheck";
}

/** One address a name resolves to. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Resolves a host name to every address it has; fails when it has none. */
export type Resolver = (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>;

const systemResolver: Resolver = (hostname) => NodeDns.promises.lookup(hostname, { all: true });

export interface GuardOptions {
  /** The largest answer read, in bytes, before the request fails with {@link ResponseTooLarge}. */
  readonly maxResponseBytes: number;
  /** How long a connection may take to open, in milliseconds. */
  readonly connectTimeoutMs: number;
  /** The system's resolver, apart from tests. */
  readonly resolve: Resolver;
}

export const DEFAULT_GUARD: GuardOptions = {
  maxResponseBytes: 8 * 1024 * 1024,
  connectTimeoutMs: 10_000,
  resolve: systemResolver,
};

/** Whether an address outside this machine may be reached under `policy`. */
const remoteAllowed = (address: string, policy: UrlPolicy) =>
  isPublicAddress(address) ||
  (policy.privateNetwork === "allow" && isPrivateNetworkAddress(address));

const isLoopbackName = (host: string) => host === "localhost" || host.endsWith(".localhost");

/** The hostname as Node's request options take it: an IPv6 literal without its brackets. */
const bareHost = (hostname: string) =>
  hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

/**
 * Whether `url` may be requested under `policy`, judged from the URL alone. A
 * host name passes here and is judged again by its addresses when the
 * connection opens.
 */
export const checkUrl = (url: string | URL, policy: UrlPolicy): Result.Result<URL, UrlRefused> => {
  const parsed = typeof url === "string" ? URL.parse(url) : url;
  if (parsed === null || parsed.hostname === "") {
    return Result.fail(new UrlRefused({ reason: "invalid-url" }));
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return Result.fail(new UrlRefused({ reason: "userinfo" }));
  }
  const host = bareHost(parsed.hostname);
  const loopback = isLoopbackAddress(host) || isLoopbackName(host);
  const loopbackAllowed = policy.loopback === "allow-http" && loopback;
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopbackAllowed)) {
    return Result.fail(new UrlRefused({ reason: "not-https" }));
  }
  if (isAddressLiteral(host) && !remoteAllowed(host, policy) && !loopbackAllowed) {
    return Result.fail(new UrlRefused({ reason: refusalOf([host], parsed.protocol, policy) }));
  }
  if (isLoopbackName(host) && !loopbackAllowed) {
    return Result.fail(new UrlRefused({ reason: "private-address" }));
  }
  return Result.succeed(parsed);
};

/**
 * Whether a resolved address may be connected to. Plain HTTP goes only to
 * loopback; HTTPS goes to public addresses, to a private network's when the
 * operator confirmed it, and to loopback when the policy allows a command
 * connector's.
 */
const addressAllowed = (address: string, protocol: string, policy: UrlPolicy) =>
  protocol === "http:"
    ? isLoopbackAddress(address)
    : remoteAllowed(address, policy) ||
      (policy.loopback === "allow-http" && isLoopbackAddress(address));

/**
 * Why addresses were refused: only for being in a private network the
 * operator did not confirm, which they may for a remote connector, or for
 * anything else. A command connector's server is on this machine, and
 * nothing confirms another network for it.
 */
const refusalOf = (
  addresses: ReadonlyArray<string>,
  protocol: string,
  policy: UrlPolicy,
): "private-address" | "private-network" =>
  protocol === "https:" &&
  policy.loopback === "refuse" &&
  policy.privateNetwork === "refuse" &&
  addresses.every((address) => isPublicAddress(address) || isPrivateNetworkAddress(address))
    ? "private-network"
    : "private-address";

/**
 * A lookup for Node's connection that resolves the name, refuses it unless
 * every address it resolves to is allowed, and hands the connection only
 * those addresses. Node connects to what this returns, so the address that
 * was checked is the one connected to.
 */
const guardedLookup =
  (protocol: string, policy: UrlPolicy, resolve: Resolver): NodeNet.LookupFunction =>
  (hostname, options, callback) => {
    resolve(hostname).then(
      (resolved) => {
        const addresses = resolved.filter(
          (a) =>
            options.family === undefined || options.family === 0 || a.family === options.family,
        );
        const [first] = addresses;
        if (first === undefined) {
          callback(new UrlRefused({ reason: "private-address" }), "", 0);
        } else if (!resolved.every((a) => addressAllowed(a.address, protocol, policy))) {
          const reason = refusalOf(
            resolved.map((a) => a.address),
            protocol,
            policy,
          );
          callback(new UrlRefused({ reason }), "", 0);
        } else if (options.all === true) {
          callback(
            null,
            addresses.map(({ address, family }) => ({ address, family })),
          );
        } else {
          callback(null, first.address, first.family);
        }
      },
      () => callback(new Unreachable({ reason: "dns" }), "", 0),
    );
  };

const isOwnError = Schema.is(Schema.Union([UrlRefused, Unreachable, ResponseTooLarge]));

const TLS_ERROR = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/;

/** Our own refusal as it was raised, or a fixed error for what Node reported: never its message. */
const connectionError = (error: unknown): Error => {
  if (isOwnError(error)) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (typeof code === "string" && TLS_ERROR.test(code)) return new Unreachable({ reason: "tls" });
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  ) {
    return new Unreachable({ reason: "connect" });
  }
  return new Unreachable({ reason: "closed" });
};

/** Statuses whose answer has no body, which a WHATWG `Response` refuses one for. */
const NO_BODY = new Set([101, 204, 205, 304]);

/** A reason phrase is the server's text; a `Response` refuses one with characters outside a header value's. */
const REASON_PHRASE = /^[\t\x20-\x7e]*$/;

/**
 * The answer's bytes as a web stream, read only while the reader wants more,
 * failing with {@link ResponseTooLarge} once past `limit` bytes.
 */
const capped = (body: NodeHttp.IncomingMessage, limit: number): ReadableStream<Uint8Array> => {
  let read = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      body.on("data", (chunk: Buffer) => {
        read += chunk.byteLength;
        if (read > limit) {
          controller.error(new ResponseTooLarge({ limit }));
          body.destroy();
          return;
        }
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 0) <= 0) body.pause();
      });
      body.once("end", () => controller.close());
      body.once("error", (error) => controller.error(connectionError(error)));
      body.once("close", () => {
        if (!body.complete) controller.error(new Unreachable({ reason: "closed" }));
      });
    },
    pull() {
      body.resume();
    },
    cancel() {
      body.destroy();
    },
  });
};

const toHeaders = (raw: ReadonlyArray<string>): Headers => {
  const headers = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (name === undefined || value === undefined) continue;
    try {
      headers.append(name, value);
    } catch {
      // A header the WHATWG rules refuse is dropped: it is the server's, and nothing here needs it.
    }
  }
  return headers;
};

/** What a guarded fetch sends a request with: fetch's own signature. */
export type GuardedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const send = (
  url: URL,
  request: Request,
  body: Uint8Array | null,
  policy: UrlPolicy,
  options: GuardOptions,
  agents: { readonly http: NodeHttp.Agent; readonly https: NodeHttps.Agent },
): Promise<Response> =>
  new Promise<Response>((resolve, reject) => {
    const signal = request.signal;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const https = url.protocol === "https:";
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const outgoing = (https ? NodeHttps : NodeHttp).request({
      protocol: url.protocol,
      hostname: bareHost(url.hostname),
      port: url.port === "" ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers,
      agent: https ? agents.https : agents.http,
      lookup: guardedLookup(url.protocol, policy, options.resolve),
      signal,
    });
    const fail = (error: unknown) => {
      reject(signal.aborted ? signal.reason : connectionError(error));
    };
    outgoing.on("error", fail);
    // Only opening the connection has a deadline here: a long call may stay
    // quiet for minutes, and its own deadline belongs to the caller.
    outgoing.on("socket", (socket) => {
      if (!socket.connecting) return;
      const late = () => outgoing.destroy(new Unreachable({ reason: "connect" }));
      socket.setTimeout(options.connectTimeoutMs, late);
      socket.once(https ? "secureConnect" : "connect", () => {
        socket.setTimeout(0);
        socket.off("timeout", late);
      });
    });
    outgoing.on("response", (incoming) => {
      const status = incoming.statusCode ?? 0;
      if (status >= 300 && status < 400 && incoming.headers.location !== undefined) {
        if (policy.redirects === "refuse") {
          incoming.destroy();
          reject(new UrlRefused({ reason: "redirect" }));
          return;
        }
      }
      if (status < 200 || status > 599) {
        incoming.destroy();
        reject(new Unreachable({ reason: "closed" }));
        return;
      }
      const statusText = REASON_PHRASE.test(incoming.statusMessage ?? "")
        ? (incoming.statusMessage ?? "")
        : "";
      const hasBody = !NO_BODY.has(status) && request.method !== "HEAD";
      if (!hasBody) incoming.resume();
      resolve(
        new Response(hasBody ? capped(incoming, options.maxResponseBytes) : null, {
          status,
          statusText,
          headers: toHeaders(incoming.rawHeaders),
        }),
      );
    });
    outgoing.end(body ?? undefined);
  });

/**
 * A fetch that sends every request through the guard, under `policy`. It holds
 * its own connections, which close with the scope.
 */
export const makeGuardedFetch = (
  policy: UrlPolicy,
  options: GuardOptions = DEFAULT_GUARD,
): Effect.Effect<GuardedFetch, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => ({
      http: new NodeHttp.Agent({ keepAlive: true }),
      https: new NodeHttps.Agent({ keepAlive: true }),
    })),
    (agents) =>
      Effect.sync(() => {
        agents.http.destroy();
        agents.https.destroy();
      }),
  ).pipe(
    Effect.map((agents): GuardedFetch => async (input, init) => {
      const target = input instanceof Request ? input.url : input;
      const checked = checkUrl(target, policy);
      if (Result.isFailure(checked)) throw checked.failure;
      const request = new Request(input, { ...init, redirect: "manual" });
      const body = request.body === null ? null : new Uint8Array(await request.arrayBuffer());
      return send(checked.success, request, body, policy, options, agents);
    }),
  );

/**
 * Effect's HTTP client over a guarded fetch: for sign-in requests to the
 * addresses a remote server names (discovery, registration, tokens).
 */
export const layerGuardedHttpClient = (
  policy: UrlPolicy,
  options: GuardOptions = DEFAULT_GUARD,
): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.effect(FetchHttpClient.Fetch, makeGuardedFetch(policy, options))),
  );
