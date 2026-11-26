// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the fake checks PKCE with node:crypto's synchronous SHA-256, as a real server would.
import * as NodeCrypto from "node:crypto";
import { DEFAULT_SESSION_LIMITS } from "@j3-bots/connectors";
import { ConnectorId, ConnectorOrigin } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ConnectorReach } from "../connectors/Connectors.ts";
import { ConnectorStore } from "../connectors/ConnectorStore.ts";
import { OAuthHttp } from "../connectors/oauth/endpoints.ts";
import { Vault } from "../vault/Vault.ts";

// A fake MCP server and its authorization server, reached through the client
// sign-ins use, as a provider would answer them: the 401 challenge, the
// metadata documents, registration, the authorization step a browser takes,
// the token endpoint and revocation. It checks what a real server checks
// (PKCE, the redirect, the resource, the client) and records every request,
// so a test can say what J3 Bots sent and to whom.

export const MCP_URL = "https://mcp.example.test/mcp";
export const AS_ORIGIN = "https://auth.example.test";

/** How the fake behaves; each test changes what it needs. */
export interface FakeOptions {
  /** The MCP server it guards, as a connector names it. */
  readonly server: string;
  /** Where its protected resource metadata is: named in the challenge, at the path-inserted address, or only at the root. */
  readonly resourceMetadata: "challenge" | "path" | "root";
  /** The `resource` the metadata names. */
  readonly resource: string;
  /** The issuer's path, which the metadata addresses insert or append. */
  readonly issuerPath: "" | "/tenant" | "/tenant/";
  /** Which of the specification's addresses serves its authorization server metadata. */
  readonly metadataAt: "oauth" | "oidc-inserted" | "oidc-appended";
  /** The `issuer` its metadata names; the real one when null. */
  readonly claimedIssuer: string | null;
  readonly s256: boolean;
  readonly registration: boolean;
  readonly revocation: boolean;
  /** Whether it sends `iss` on the redirect (RFC 9207) and says so. */
  readonly issParameter: boolean;
  /** Whether each refresh gives a new refresh token and ends the old one. */
  readonly rotate: boolean;
  /** An access token's lifetime in seconds; none when null. */
  readonly lifetime: number | null;
  /** Whether the token endpoint answers 503, as a server that is down. */
  readonly down: boolean;
  /** Whether it gives refresh tokens. */
  readonly refresh: boolean;
  /** Whether an address it has nothing at answers 200 with a page, as a catch-all route does. */
  readonly catchAll: boolean;
  /** Whether the token endpoint's answer starts and never ends. */
  readonly stall: boolean;
  /** Paths of the authorization server that answer 501, as a server failing there. */
  readonly failing: ReadonlyArray<string>;
}

const defaultOptions: FakeOptions = {
  server: MCP_URL,
  resourceMetadata: "challenge",
  resource: MCP_URL,
  issuerPath: "",
  metadataAt: "oauth",
  claimedIssuer: null,
  s256: true,
  registration: true,
  revocation: true,
  issParameter: false,
  rotate: true,
  lifetime: 3600,
  down: false,
  refresh: true,
  catchAll: false,
  stall: false,
  failing: [],
};

/** A request the fake received. */
export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface Code {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly resource: string | null;
  readonly scope: string | null;
}

/** Whether a redirect matches a registered one: exactly, or on loopback with any port. */
const sameRedirect = (registered: string, requested: string) => {
  if (registered === requested) return true;
  const a = new URL(registered);
  const b = new URL(requested);
  return (
    a.protocol === "http:" &&
    a.hostname === "127.0.0.1" &&
    b.protocol === "http:" &&
    b.hostname === "127.0.0.1" &&
    a.pathname === b.pathname
  );
};

const s256 = (verifier: string) =>
  NodeCrypto.createHash("sha256").update(verifier).digest("base64url");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** A registration request, as far as the fake reads it. */
const decodeRegistration = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      redirect_uris: Schema.Array(Schema.String),
      token_endpoint_auth_method: Schema.String,
    }),
  ),
);

/** Holds the fake's requests to one endpoint: see `FakeAuthorizationServer.gate`. */
export interface RequestGate {
  readonly endpoint: string;
  readonly arrived: Deferred.Deferred<void>;
  readonly open: Deferred.Deferred<void>;
}

/** A gate for the authorization server's `endpoint` (its path), neither side completed. */
export const requestGate = (endpoint = "/token"): Effect.Effect<RequestGate> =>
  Effect.all({
    endpoint: Effect.succeed(endpoint),
    arrived: Deferred.make<void>(),
    open: Deferred.make<void>(),
  });

export class FakeAuthorizationServer {
  options: FakeOptions;
  readonly received: Array<Received> = [];
  readonly clients = new Map<
    string,
    {
      readonly secret: string | null;
      readonly method: string;
      readonly redirectUris: ReadonlyArray<string>;
    }
  >();
  readonly codes = new Map<string, Code>();
  /** Refresh tokens that still work, to the client they belong to. */
  readonly refreshTokens = new Map<string, string>();
  readonly revoked: Array<string> = [];
  private counter = 0;
  /**
   * While set, a request to its endpoint completes `arrived` when it reaches
   * the fake, and is answered only once `open` completes.
   */
  gate: RequestGate | null = null;

  constructor(options: Partial<FakeOptions> = {}) {
    this.options = { ...defaultOptions, ...options };
  }

  /** Guards `server` from now on, which its metadata names as the resource. */
  guard(server: string) {
    this.options = { ...this.options, server, resource: server };
  }

  get issuer() {
    return `${AS_ORIGIN}${this.options.issuerPath}`;
  }

  private next(prefix: string) {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  /** Registers a client the operator made at this provider, as for their own app. */
  addClient(clientId: string, secret: string | null) {
    this.clients.set(clientId, {
      secret,
      method: secret === null ? "none" : "client_secret_post",
      redirectUris: [],
    });
  }

  /** The tokens it handed out so far, which no log or answer may show. */
  readonly issued: Array<string> = [];

  /** The access token a request carries now: the last one it handed out. */
  get bearer(): Option.Option<Redacted.Redacted<string>> {
    return Option.map(
      Option.fromNullishOr(this.issued.filter((token) => token.startsWith("access")).at(-1)),
      Redacted.make,
    );
  }

  /**
   * What a browser does with the address J3 Bots opened: the operator
   * approves (or declines), and the provider sends the browser back to the
   * redirect with a code and the `state`.
   */
  authorize(address: string, approve = true): string {
    const url = new URL(address);
    const params = url.searchParams;
    const redirectUri = params.get("redirect_uri") ?? "";
    // A client registered with redirects returns only to one of them, on
    // loopback to any port (RFC 8252 §7.3); a provider shows an error page
    // otherwise, and the browser never comes back.
    const registered = this.clients.get(params.get("client_id") ?? "")?.redirectUris ?? [];
    if (registered.length > 0 && !registered.some((uri) => sameRedirect(uri, redirectUri))) {
      throw new Error(`The provider refuses the redirect ${redirectUri}`);
    }
    const back = new URL(redirectUri);
    back.searchParams.set("state", params.get("state") ?? "");
    if (this.options.issParameter) back.searchParams.set("iss", this.issuer);
    if (!approve) {
      back.searchParams.set("error", "access_denied");
      return back.href;
    }
    const code = this.next("code");
    this.issued.push(code);
    this.codes.set(code, {
      clientId: params.get("client_id") ?? "",
      redirectUri,
      challenge: params.get("code_challenge") ?? "",
      resource: params.get("resource"),
      scope: params.get("scope"),
    });
    back.searchParams.set("code", code);
    return back.href;
  }

  private metadata() {
    return {
      issuer: this.options.claimedIssuer ?? this.issuer,
      authorization_endpoint: `${AS_ORIGIN}/authorize`,
      token_endpoint: `${AS_ORIGIN}/token`,
      ...(this.options.registration ? { registration_endpoint: `${AS_ORIGIN}/register` } : {}),
      ...(this.options.revocation ? { revocation_endpoint: `${AS_ORIGIN}/revoke` } : {}),
      response_types_supported: ["code"],
      code_challenge_methods_supported: this.options.s256 ? ["S256"] : ["plain"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      ...(this.options.issParameter
        ? { authorization_response_iss_parameter_supported: true }
        : {}),
    };
  }

  private metadataPath() {
    // The addresses take the issuer's path without its trailing slash (RFC 8414 §3.1).
    const path = this.options.issuerPath.replace(/\/$/, "");
    switch (this.options.metadataAt) {
      case "oauth":
        return `/.well-known/oauth-authorization-server${path}`;
      case "oidc-inserted":
        return `/.well-known/openid-configuration${path}`;
      case "oidc-appended":
        return `${path}/.well-known/openid-configuration`;
    }
  }

  /** The client a token or revocation request authenticates as, or null when it fails to. */
  private client(headers: Headers, form: URLSearchParams): string | null {
    const basic = headers.get("authorization");
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    if (basic?.startsWith("Basic ")) {
      const [user = "", pass = ""] = Buffer.from(basic.slice(6), "base64").toString().split(":");
      id = decodeURIComponent(user);
      secret = decodeURIComponent(pass);
    }
    const known = id === null ? undefined : this.clients.get(id);
    if (id === null || known === undefined) return null;
    if (known.secret !== null && known.secret !== secret) return null;
    return id;
  }

  private tokens(clientId: string, scope: string | null) {
    const access = this.next("access");
    this.issued.push(access);
    let refresh: string | null = null;
    if (this.options.refresh) {
      refresh = this.next("refresh");
      this.issued.push(refresh);
      this.refreshTokens.set(refresh, clientId);
    }
    return json({
      access_token: access,
      token_type: "Bearer",
      ...(this.options.lifetime === null ? {} : { expires_in: this.options.lifetime }),
      ...(refresh === null ? {} : { refresh_token: refresh }),
      ...(scope === null ? {} : { scope }),
    });
  }

  handle(method: string, url: URL, headers: Headers, body: string): Response {
    const at = `${url.origin}${url.pathname}`;
    if (url.origin === AS_ORIGIN && this.options.failing.includes(url.pathname)) {
      return new Response(null, { status: 501 });
    }
    const server = new URL(this.options.server);
    const mcpMetadata = `${server.origin}/.well-known/oauth-protected-resource`;
    if (method === "POST" && at === this.options.server) {
      const pointer =
        this.options.resourceMetadata === "challenge"
          ? `Bearer resource_metadata="${mcpMetadata}${server.pathname}", scope="read write"`
          : `Bearer realm="mcp"`;
      return new Response(null, { status: 401, headers: { "www-authenticate": pointer } });
    }
    if (method === "GET" && url.origin === server.origin) {
      const served =
        this.options.resourceMetadata === "root" ? mcpMetadata : `${mcpMetadata}${server.pathname}`;
      if (at !== served) return new Response(null, { status: 404 });
      return json({
        resource: this.options.resource,
        authorization_servers: [this.issuer],
        scopes_supported: ["read", "write"],
      });
    }
    if (method === "GET" && url.origin === AS_ORIGIN) {
      if (url.pathname === this.metadataPath()) return json(this.metadata());
      return this.options.catchAll
        ? new Response("<!doctype html><p>Welcome</p>", {
            headers: { "content-type": "text/html" },
          })
        : new Response(null, { status: 404 });
    }
    if (method === "POST" && at === `${AS_ORIGIN}/register` && this.options.registration) {
      const request = decodeRegistration(body);
      const clientId = this.next("client");
      const secret = request.token_endpoint_auth_method === "none" ? null : this.next("secret");
      this.clients.set(clientId, {
        secret,
        method: request.token_endpoint_auth_method,
        redirectUris: request.redirect_uris,
      });
      return json(
        {
          client_id: clientId,
          ...(secret === null ? {} : { client_secret: secret }),
          token_endpoint_auth_method: request.token_endpoint_auth_method,
          redirect_uris: request.redirect_uris,
        },
        201,
      );
    }
    if (method === "POST" && at === `${AS_ORIGIN}/token`) {
      if (this.options.down) return new Response(null, { status: 503 });
      if (this.options.stall) {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode('{"access_token":')),
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      const form = new URLSearchParams(body);
      const clientId = this.client(headers, form);
      if (clientId === null) return json({ error: "invalid_client" }, 401);
      if (form.get("resource") !== this.options.resource) {
        return json({ error: "invalid_target" }, 400);
      }
      if (form.get("grant_type") === "authorization_code") {
        const code = this.codes.get(form.get("code") ?? "");
        this.codes.delete(form.get("code") ?? "");
        if (
          code === undefined ||
          code.clientId !== clientId ||
          code.redirectUri !== form.get("redirect_uri") ||
          code.resource !== form.get("resource") ||
          s256(form.get("code_verifier") ?? "") !== code.challenge
        ) {
          return json(
            { error: "invalid_grant", error_description: "described by the server" },
            400,
          );
        }
        return this.tokens(clientId, code.scope);
      }
      if (form.get("grant_type") === "refresh_token") {
        const presented = form.get("refresh_token") ?? "";
        if (this.refreshTokens.get(presented) !== clientId) {
          return json({ error: "invalid_grant" }, 400);
        }
        if (!this.options.rotate) {
          const access = this.next("access");
          this.issued.push(access);
          return json({
            access_token: access,
            token_type: "bearer",
            ...(this.options.lifetime === null
              ? {}
              : { expires_in: String(this.options.lifetime) }),
          });
        }
        this.refreshTokens.delete(presented);
        return this.tokens(clientId, null);
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (method === "POST" && at === `${AS_ORIGIN}/revoke` && this.options.revocation) {
      const form = new URLSearchParams(body);
      if (this.client(headers, form) === null) return json({ error: "invalid_client" }, 401);
      const token = form.get("token") ?? "";
      this.revoked.push(token);
      this.refreshTokens.delete(token);
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  }

  /** The client sign-ins use, answered by this fake. */
  get layer() {
    return Layer.succeed(
      OAuthHttp,
      HttpClient.make((request, url) => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const headers = new Headers(request.headers);
        return Effect.sync(() =>
          this.received.push({
            method: request.method,
            url: url.href,
            headers: Object.fromEntries(headers.entries()),
            body,
          }),
        ).pipe(
          Effect.andThen(() => {
            const gate = this.gate;
            return gate !== null && url.href === `${AS_ORIGIN}${gate.endpoint}`
              ? Deferred.succeed(gate.arrived, undefined).pipe(
                  Effect.andThen(Deferred.await(gate.open)),
                )
              : Effect.void;
          }),
          Effect.map(() =>
            HttpClientResponse.fromWeb(request, this.handle(request.method, url, headers, body)),
          ),
        );
      }),
    );
  }
}

/** The fake every sign-in of the test domain reaches, which a test can change and read. */
export class TestOAuth extends Context.Service<TestOAuth, FakeAuthorizationServer>()(
  "@j3-bots/server/testing/oauth/TestOAuth",
) {}

/** A fresh fake with its default options, as `TestOAuth` and as the client sign-ins use. */
export const layer = Layer.unwrap(
  Effect.sync(() => {
    const fake = new FakeAuthorizationServer();
    return Layer.merge(Layer.succeed(TestOAuth, fake), fake.layer);
  }),
);

/** The connector `addOAuthConnector` adds. */
export const NOTION = ConnectorId.make("conn_aaaaaaaaaaaaaaaa");

/**
 * Adds the fake's MCP server as a connector that signs in with OAuth, for
 * every bot, its address in the vault, which must be unlocked.
 */
export const addOAuthConnector = Effect.gen(function* () {
  const store = yield* ConnectorStore;
  yield* (yield* Vault).connectorSecrets.put({
    connectorId: NOTION,
    address: Redacted.make(MCP_URL),
    oauth: null,
    headers: [],
    command: null,
    env: [],
    formSecrets: [],
  });
  yield* store.insert({
    id: NOTION,
    name: "Notion",
    glyph: null,
    publisher: { _tag: "operator" },
    listing: null,
    transport: { _tag: "remote", origin: ConnectorOrigin.make(new URL(MCP_URL).origin) },
    signIn: "oauth",
    fields: [],
    privateNetwork: false,
    grant: { _tag: "all-bots" },
    lastChange: null,
    signedInAt: null,
    accepted: null,
    keptRevision: null,
    createdAt: yield* DateTime.now,
  });
});

/**
 * How the domain reaches connectors' servers in a test that adds one: no
 * name resolves, so the listing a sign-in starts fails at once rather than
 * looking the fake's name up on the network.
 */
export const unresolvable = Layer.succeed(ConnectorReach, {
  limits: {
    ...DEFAULT_SESSION_LIMITS,
    guard: {
      ...DEFAULT_SESSION_LIMITS.guard,
      resolve: () => Promise.reject(new Error("no such host")),
    },
  },
  loopback: "refuse",
});
