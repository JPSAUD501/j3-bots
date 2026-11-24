// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AuthFailing,
  type CredentialsUnavailable,
  NeedsSignIn,
  VaultLocked,
} from "@j3-bots/connectors";
import {
  type Conflict,
  type ConnectorSignIn,
  type DeviceId,
  type SignInRedirect,
  type SignInRedirects,
  signInCallbackPath,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import { ServerConfig } from "../../config.ts";
import type { SignInState } from "../auth.ts";
import { hiddenOf } from "../credentials.ts";
import { Listener } from "../../listener.ts";
import type {
  ConnectorId,
  ConnectorSecret,
  OAuthClient,
  OAuthTokens,
} from "../../vault/ConnectorSecret.ts";
import { Vault } from "../../vault/Vault.ts";
import * as Endpoints from "./endpoints.ts";
import { OAuthFailure, type OAuthFailureReason } from "./errors.ts";
import {
  type AuthMethod,
  type AuthorizationServerMetadata,
  canonicalResource,
  chooseAuthMethod,
  parseBearerChallenge,
  redirectMatches,
  resourceCovers,
  resourceMetadataUrls,
  sameIssuer,
  scopesOf,
  secureUrl,
} from "./protocol.ts";

/** How the address a browser returned to reaches the server. */
export type SignInReturn =
  /** A device relayed it, or the operator pasted it; only the device that started the sign-in may. */
  | {
      readonly _tag: "device";
      readonly deviceId: DeviceId;
      readonly url: Redacted.Redacted<string>;
    }
  /** The server's own callback received it: the path it was sent to, and its query, after `?`. */
  | {
      readonly _tag: "callback";
      readonly path: string;
      readonly query: Redacted.Redacted<string>;
    };

/** A path as a URL parser reads it, for comparing two spellings of one. */
const normalPath = (path: string) => new URL(path, "http://path.invalid").pathname;

/** How long a sign-in waits for the browser to come back. */
const SIGN_IN_LIFETIME = Duration.minutes(10);

/**
 * A token is refreshed this long before it expires, or halfway through its
 * life when that is shorter…
 */
const REFRESH_AHEAD = Duration.minutes(5);

/** …and one this close to expiring is refreshed before it is handed out. */
const USE_MARGIN = Duration.minutes(1);

/** Authorization server metadata is read again after this long. */
const METADATA_LIFETIME = Duration.hours(1);

/**
 * A refresh that failed for a reason that may pass (the server unreachable)
 * is tried again after 30 s, doubling to at most 15 minutes, until it works
 * or the server refuses the grant; and once more the moment the token
 * expires, so the connector shows failing from then on.
 */
const FIRST_RETRY = Duration.seconds(30);
const LAST_RETRY = Duration.minutes(15);

/**
 * The connectors that sign in with OAuth, as the connectors' store knows
 * them. The server provides it from the store (`signIns.ts`); nothing else
 * here knows how connectors are kept. Where a connector's server is comes
 * from its record in the vault, since its address can carry a key.
 */
export class OAuthConnectors extends Context.Service<
  OAuthConnectors,
  {
    /** How the connector signs in; none for an unknown connector. */
    readonly signInOf: (id: ConnectorId) => Effect.Effect<Option.Option<ConnectorSignIn>>;
    /** Every connector that signs in with OAuth. */
    readonly all: Effect.Effect<ReadonlyArray<ConnectorId>>;
    /**
     * What a sign-in to the connector asks for beyond what its server names:
     * the scopes and authorization request parameters of the gallery entry
     * it was added from, as an own app's. Nothing for another connector.
     */
    readonly authorizationOf: (id: ConnectorId) => Effect.Effect<AuthorizationExtras>;
  }
>()("@j3-bots/server/connectors/oauth/ConnectorAuth/OAuthConnectors") {}

/** What a sign-in asks for beyond what the connector's server names. */
export interface AuthorizationExtras {
  readonly scopes: ReadonlyArray<string>;
  /** Added to the authorization request, never in place of one J3 Bots sets. */
  readonly parameters: Readonly<Record<string, string>>;
}

/** A client the operator registered at a provider, as they paste it. */
export interface OperatorClient {
  /** The authorization server the operator registered it at. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: Option.Option<Redacted.Redacted<string>>;
}

/**
 * Sign-ins to connectors' servers, done by the server (MCP authorization,
 * revision 2025-11-25): discovery, registration, the code flow with PKCE,
 * `state` and the resource indicator, then the tokens, kept in the vault and
 * refreshed ahead of expiry. No token, code, verifier or `state` leaves this
 * service but the access token a connector's call needs, and that only to
 * the connectors' client.
 */
export class ConnectorAuth extends Context.Service<
  ConnectorAuth,
  {
    /**
     * Starts a sign-in for the connector, from `deviceId`, returning to
     * `redirect`: the address to open in a browser, and when the sign-in
     * stops waiting. A sign-in started earlier for the same connector ends.
     */
    readonly begin: (input: {
      readonly connectorId: ConnectorId;
      readonly deviceId: DeviceId;
      readonly redirect: SignInRedirect;
    }) => Effect.Effect<
      { readonly authorizationUrl: string; readonly expiresAt: DateTime.Utc },
      OAuthFailure
    >;
    /**
     * Where a sign-in at `issuer` returns, for an operator who registers an
     * app there: the addresses `begin` would use.
     */
    readonly redirectsFor: (issuer: string) => Effect.Effect<SignInRedirects>;
    /** Ends a sign-in with where the browser returned to. Answers the connector it signed in. */
    readonly complete: (by: SignInReturn) => Effect.Effect<ConnectorId, OAuthFailure>;
    /**
     * Saves a client the operator registered at the connector's provider, as
     * for their own Google or Slack app, after discovery found the
     * authorization server it belongs to. It replaces the connector's client
     * and any sign-in made with another.
     */
    readonly useOperatorClient: (
      connectorId: ConnectorId,
      client: OperatorClient,
    ) => Effect.Effect<void, OAuthFailure>;
    /**
     * The access token for a call to the connector's server, refreshed first
     * when it expired or is about to.
     */
    readonly accessToken: (
      connectorId: ConnectorId,
    ) => Effect.Effect<Redacted.Redacted<string>, CredentialsUnavailable>;
    /**
     * The connector's server refused `sent`, the access token a request
     * carried, with this `WWW-Authenticate`: refresh it now. A token that is
     * no longer the connector's (a sign-in or a refresh replaced it while the
     * request ran) is left alone, since the request goes again with the
     * current one. Fails `NeedsSignIn` when the grant is gone, or when the
     * server needs a scope the token lacks (`insufficient_scope`), which the
     * next sign-in then asks for.
     */
    readonly rejected: (
      connectorId: ConnectorId,
      wwwAuthenticate: Option.Option<string>,
      sent: Option.Option<Redacted.Redacted<string>>,
    ) => Effect.Effect<void, CredentialsUnavailable>;
    /**
     * Signs the connector out: revokes its tokens where the server offers it,
     * then deletes them, with a client J3 Bots registered. The operator's own
     * client stays. Revocation that fails is not retried: the tokens are gone
     * from here either way.
     */
    readonly disconnect: (connectorId: ConnectorId) => Effect.Effect<void, OAuthFailure>;
    /** Every OAuth connector's sign-in state now, then each change. */
    readonly states: Stream.Stream<ReadonlyMap<ConnectorId, SignInState>>;
    /**
     * Each connector the operator signs in to from the moment this is run,
     * as its sign-in completes, for as long as its scope.
     */
    readonly signedIn: Effect.Effect<Stream.Stream<ConnectorId>, never, Scope.Scope>;
  }
>()("@j3-bots/server/connectors/oauth/ConnectorAuth") {}

/** A sign-in under way, kept only in memory: a restart ends it. */
interface Pending {
  readonly connectorId: ConnectorId;
  readonly deviceId: DeviceId;
  readonly server: boolean;
  readonly redirectUri: string;
  readonly verifier: Redacted.Redacted<string>;
  readonly metadata: AuthorizationServerMetadata;
  readonly client: OAuthClient;
  readonly resource: string;
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: DateTime.Utc;
  /** The connector's sign-in generation it began in. */
  readonly generation: number;
}

/** The parts of an address a redirect is matched on: no query, no fragment. */
const redirectOf = (url: URL) => `${url.protocol}//${url.host}${url.pathname}`;

const fail = (reason: OAuthFailureReason) => Effect.fail(new OAuthFailure({ reason }));

/**
 * The vault refuses only while it cannot be used: locked, without a master
 * password, or written by a newer release, which is locked as far as a
 * connector can tell.
 */
const fromVault = <A>(effect: Effect.Effect<A, Conflict>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new OAuthFailure({
          reason: error.reason === "vault-not-set-up" ? "vault-not-set-up" : "vault-locked",
        }),
    ),
  );

/** The client as the token endpoint needs it. */
const tokenClient = (client: OAuthClient): Endpoints.TokenClient => ({
  clientId: client.clientId,
  clientSecret: Option.fromNullOr(client.clientSecret),
  authMethod: client.authMethod,
});

export const layer = Layer.effect(
  ConnectorAuth,
  Effect.gen(function* () {
    const vault = yield* Vault;
    const connectors = yield* OAuthConnectors;
    const config = yield* ServerConfig;
    const listener = yield* Listener;
    const random = yield* SecureRandom.SecureRandom;
    const digest = yield* Digest.Digest;
    const http = yield* Endpoints.OAuthHttp;
    const withHttp = Effect.provideService(Endpoints.OAuthHttp, http);

    const pending = new Map<string, Pending>();
    const metadataCache = new Map<
      string,
      { readonly metadata: AuthorizationServerMetadata; readonly until: DateTime.Utc }
    >();
    const locks = new Map<ConnectorId, Semaphore.Semaphore>();
    /** Scopes a connector's server refused a call for lacking, which its next sign-in asks for too. */
    const stepUp = new Map<ConnectorId, ReadonlyArray<string>>();
    const states = yield* SubscriptionRef.make<ReadonlyMap<ConnectorId, SignInState>>(new Map());
    const completed = yield* PubSub.unbounded<ConnectorId>();
    /**
     * Each connector's sign-in generation: a new sign-in, another client or a
     * sign-out starts the next, and a sign-in of an earlier one that finishes
     * after it is dropped, so it cannot undo what came after it.
     */
    const generations = new Map<ConnectorId, number>();
    const nextGeneration = (id: ConnectorId) => {
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      return generation;
    };
    /**
     * Tokens a refresh got but could not save, the vault having locked while
     * it waited for them: a server that rotated the refresh token has already
     * forgotten the saved one. Written before the connector's tokens are next
     * read; lost only if the server stops first.
     */
    const held = new Map<ConnectorId, NonNullable<ConnectorSecret["oauth"]>>();
    const refreshers = yield* FiberMap.make<ConnectorId>();

    const setState = (id: ConnectorId, state: Option.Option<SignInState>) =>
      SubscriptionRef.update(states, (all) => {
        const next = new Map(all);
        if (Option.isSome(state)) next.set(id, state.value);
        else next.delete(id);
        return next;
      });

    /** One refresh at a time per connector, so a rotated refresh token is never used twice. */
    const serially = (id: ConnectorId) => {
      let lock = locks.get(id);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(id, lock);
      }
      return lock.withPermits(1);
    };

    const randomText = (bytes: number) =>
      Effect.map(random.randomBytes(bytes), (value) => Base64Url.encode(value));

    /** The authorization server's metadata, read again after an hour. */
    const metadataFor = Effect.fn("ConnectorAuth.metadataFor")(function* (issuer: string) {
      const now = yield* DateTime.now;
      const cached = metadataCache.get(issuer);
      if (cached !== undefined && DateTime.isLessThan(now, cached.until)) return cached.metadata;
      const metadata = yield* withHttp(Endpoints.authorizationServerMetadata(issuer));
      metadataCache.set(issuer, { metadata, until: DateTime.addDuration(now, METADATA_LIFETIME) });
      return metadata;
    });

    /**
     * Discovery for the connector's server: its challenge, its protected
     * resource metadata, and its authorization server's metadata, checked.
     */
    const discover = Effect.fn("ConnectorAuth.discover")(function* (id: ConnectorId) {
      const signIn = yield* connectors.signInOf(id);
      if (Option.isNone(signIn)) return yield* fail("unknown-connector");
      if (signIn.value !== "oauth") return yield* fail("not-oauth");
      // Sealed when the connector was added: typed, or given by its gallery entry's form.
      const secret = yield* secretOf(id);
      const address = Option.flatMap(secret, ({ address }) => Option.fromNullOr(address));
      if (Option.isNone(address)) return yield* fail("no-address");
      const found = secureUrl(Redacted.value(address.value));
      if (Option.isNone(found)) return yield* fail("insecure-endpoint");
      const server = found.value;
      const challenge = yield* withHttp(Endpoints.challenge(server));
      const named = Option.flatMap(challenge, ({ resourceMetadata }) => resourceMetadata);
      let urls = resourceMetadataUrls(server);
      if (Option.isSome(named)) {
        const url = secureUrl(named.value);
        if (Option.isNone(url)) return yield* fail("insecure-endpoint");
        urls = [url.value.href];
      }
      const resource = yield* withHttp(Endpoints.resourceMetadata(urls));
      if (!resourceCovers(resource.resource, server)) return yield* fail("resource-mismatch");
      const issuer = resource.authorization_servers?.[0];
      if (issuer === undefined) return yield* fail("no-metadata");
      const metadata = yield* metadataFor(issuer);
      const scope = Option.flatMap(challenge, (found) => found.scope);
      // The resource the metadata names may be the server's or one above it.
      const resourceUri = resource.resource === "" ? canonicalResource(server) : resource.resource;
      // It goes in the browser's address and to the authorization server: never
      // with a key the connector's form put in its address. Adding refuses
      // such a gallery entry a sign-in; this holds whatever a server names.
      const hidden = Option.match(secret, {
        onNone: () => [],
        onSome: ({ formSecrets }) => hiddenOf(formSecrets),
      });
      if (hidden.some((value) => resourceUri.includes(Redacted.value(value)))) {
        return yield* fail("secret-in-resource");
      }
      return {
        server: server,
        resource: resourceUri,
        issuer,
        metadata,
        scopes: Option.isSome(scope) ? scopesOf(scope.value) : (resource.scopes_supported ?? []),
      };
    });

    /** Where the server's own callback is, when a browser can reach it. */
    const serverOrigin = Effect.gen(function* () {
      if (Option.isSome(config.publicOrigin)) return Option.some<string>(config.publicOrigin.value);
      const bound = yield* Deferred.await(listener);
      if (bound.address === "127.0.0.1") return Option.some(`http://127.0.0.1:${bound.port}`);
      return Option.none<string>();
    });

    /**
     * Where a sign-in at `issuer` returns to. A pasted one returns to
     * loopback's default port, where nothing is expected to answer.
     */
    const redirectUriOf = Effect.fn("ConnectorAuth.redirectUriOf")(function* (
      redirect: SignInRedirect,
      issuer: string,
    ) {
      const path = signInCallbackPath(new URL(issuer));
      switch (redirect._tag) {
        case "server": {
          const origin = yield* serverOrigin;
          return Option.isSome(origin)
            ? `${origin.value}${path}`
            : yield* fail("no-server-redirect");
        }
        case "relay":
          return Number.isInteger(redirect.port) && redirect.port > 0 && redirect.port < 65536
            ? `http://127.0.0.1:${redirect.port}${path}`
            : yield* fail("address-mismatch");
        case "paste":
          return `http://127.0.0.1${path}`;
      }
    });

    const redirectsFor = Effect.fn("ConnectorAuth.redirectsFor")(function* (issuer: string) {
      const path = signInCallbackPath(new URL(issuer));
      const origin = yield* serverOrigin;
      return {
        server: Option.match(origin, { onNone: () => null, onSome: (at) => `${at}${path}` }),
        loopback: `http://127.0.0.1${path}`,
      } satisfies SignInRedirects;
    });

    const secretOf = (id: ConnectorId) => fromVault(vault.connectorSecrets.get(id));

    const save = (secret: ConnectorSecret) => fromVault(vault.connectorSecrets.put(secret));

    /**
     * Saves the connector's OAuth part, keeping its address, headers and
     * environment. `null` removes it.
     */
    const saveOAuth = Effect.fn("ConnectorAuth.saveOAuth")(function* (
      id: ConnectorId,
      oauth: ConnectorSecret["oauth"],
    ) {
      const current = yield* secretOf(id);
      const kept = Option.match(current, {
        onNone: () => ({ address: null, headers: [], command: null, env: [], formSecrets: [] }),
        onSome: ({ address, headers, command, env, formSecrets }) => ({
          address,
          headers,
          command,
          env,
          formSecrets,
        }),
      });
      if (
        oauth === null &&
        kept.address === null &&
        kept.headers.length === 0 &&
        kept.command === null &&
        kept.env.length === 0 &&
        kept.formSecrets.length === 0
      ) {
        return yield* fromVault(vault.connectorSecrets.remove(id));
      }
      yield* save({ connectorId: id, oauth, ...kept });
    });

    /** Writes the tokens a refresh could not save, when there are any. Call it serially. */
    const saveHeld = Effect.fn("ConnectorAuth.saveHeld")(function* (id: ConnectorId) {
      const tokens = held.get(id);
      if (tokens === undefined) return;
      yield* saveOAuth(id, tokens);
      held.delete(id);
    });

    /**
     * Forgets the connector's tokens: it needs a new sign-in. A client J3
     * Bots registered goes too when `dropClient`. Its refresher, which may be
     * what calls this, ends on its own when it next finds no tokens.
     */
    const signedOut = Effect.fn("ConnectorAuth.signedOut")(function* (
      id: ConnectorId,
      client: OAuthClient,
      dropClient: boolean,
    ) {
      const keep = !dropClient || client.registration === "operator";
      yield* saveOAuth(id, keep ? { client, tokens: null } : null);
      yield* setState(id, Option.some({ _tag: "needs-sign-in", reason: "expired" }));
    });

    const tokensFrom = (
      answer: Endpoints.Tokens,
      now: DateTime.Utc,
      fallback: {
        readonly scopes: ReadonlyArray<string>;
        readonly refreshToken: Option.Option<Redacted.Redacted<string>>;
        readonly signedInAt: DateTime.Utc;
      },
      resource: string,
    ): OAuthTokens => ({
      accessToken: answer.accessToken,
      // A server that rotates sends a new one; one that does not keeps the old.
      refreshToken: Option.getOrNull(
        Option.orElse(answer.refreshToken, () => fallback.refreshToken),
      ),
      expiresAt: Option.getOrNull(
        Option.map(answer.expiresIn, (lifetime) => DateTime.addDuration(now, lifetime)),
      ),
      scopes: Option.match(answer.scope, { onNone: () => fallback.scopes, onSome: scopesOf }),
      resource,
      signedInAt: fallback.signedInAt,
    });

    /**
     * Refreshes the connector's tokens and answers them. With a `margin`,
     * tokens that expire later than that, as another refresh may have left
     * them meanwhile, are answered as they are; with none, it refreshes. A
     * refused grant signs the connector out; a refused client also drops a
     * client J3 Bots registered, so the next sign-in registers again. From
     * the request to the saved answer nothing interrupts it: a server that
     * rotated the refresh token has already forgotten the old one.
     */
    const refresh = (id: ConnectorId, margin: Option.Option<Duration.Duration>) =>
      serially(id)(
        Effect.gen(function* () {
          yield* saveHeld(id);
          const secret = yield* secretOf(id);
          const oauth = Option.flatMap(secret, ({ oauth }) => Option.fromNullOr(oauth));
          if (Option.isNone(oauth) || oauth.value.tokens === null)
            return yield* fail("not-signed-in");
          const { client, tokens } = oauth.value;
          const now = yield* DateTime.now;
          if (Option.isSome(margin) && !expiresWithin(tokens, now, margin.value)) return tokens;
          const refreshToken = tokens.refreshToken;
          if (refreshToken === null) {
            // Without a refresh token, the token is used until it expires.
            const valid = tokens.expiresAt === null || DateTime.isLessThan(now, tokens.expiresAt);
            if (Option.isSome(margin) && valid) return tokens;
            yield* signedOut(id, client, false);
            return yield* fail("invalid-grant");
          }
          const metadata = yield* metadataFor(client.issuer);
          return yield* Effect.uninterruptible(
            withHttp(
              Endpoints.requestTokens({
                endpoint: metadata.token_endpoint,
                client: tokenClient(client),
                params: [
                  ["grant_type", "refresh_token"],
                  ["refresh_token", Redacted.value(refreshToken)],
                ],
                resource: tokens.resource,
              }),
            ).pipe(
              Effect.catchTag("OAuthFailure", (error) =>
                error.reason === "invalid-grant" || error.reason === "invalid-client"
                  ? Effect.andThen(
                      signedOut(id, client, error.reason === "invalid-client"),
                      Effect.fail(error),
                    )
                  : Effect.fail(error),
              ),
              Effect.flatMap((answer) => {
                const renewed = tokensFrom(
                  answer,
                  now,
                  {
                    scopes: tokens.scopes,
                    refreshToken: Option.some(refreshToken),
                    signedInAt: tokens.signedInAt,
                  },
                  tokens.resource,
                );
                // An access token that has already expired (`expires_in` 0)
                // signs nothing: the answer is kept for the refresh token it
                // may have rotated, and the refresh failed, to be tried again
                // later rather than at once.
                const usable =
                  renewed.expiresAt === null || DateTime.isLessThan(now, renewed.expiresAt);
                return saveOAuth(id, { client, tokens: renewed }).pipe(
                  Effect.tapError(() =>
                    Effect.sync(() => held.set(id, { client, tokens: renewed })),
                  ),
                  Effect.andThen(
                    usable
                      ? Effect.as(setState(id, Option.some(signedIn(renewed))), renewed)
                      : fail("invalid-response"),
                  ),
                );
              }),
            ),
          );
        }),
      );

    /**
     * Keeps the connector's token fresh: refreshes it ahead of expiry, trying
     * again while the failure may pass, and so on with each new token. Tokens
     * without a refresh token are signed out when they expire. Once a token
     * has expired with its refresh still failing, the connector is failing. A
     * refresh that fails for good ends it.
     */
    const keepFresh = Effect.fn("ConnectorAuth.keepFresh")(
      function* (id: ConnectorId, initial: OAuthTokens) {
        let tokens = initial;
        while (tokens.expiresAt !== null) {
          const expiresAt = tokens.expiresAt;
          const now = yield* DateTime.now;
          const lead =
            tokens.refreshToken === null
              ? Duration.zero
              : Duration.min(REFRESH_AHEAD, Duration.times(DateTime.distance(now, expiresAt), 0.5));
          const due = DateTime.subtractDuration(expiresAt, lead);
          if (DateTime.isLessThan(now, due)) yield* Effect.sleep(DateTime.distance(now, due));
          let wait = FIRST_RETRY;
          while (true) {
            const attempt = yield* Effect.result(refresh(id, Option.some(lead)));
            if (attempt._tag === "Success") {
              tokens = attempt.success;
              break;
            }
            const reason = attempt.failure.reason;
            if (!retryable(reason)) return;
            const at = yield* DateTime.now;
            const expired = !DateTime.isLessThan(at, expiresAt);
            if (expired) {
              yield* setState(id, Option.some({ _tag: "failing", reason: "refresh-failed" }));
            }
            yield* Effect.logWarning("A connector's token could not be refreshed").pipe(
              Effect.annotateLogs({ connector: id, reason }),
            );
            yield* Effect.sleep(
              expired ? wait : Duration.min(wait, DateTime.distance(at, expiresAt)),
            );
            wait = Duration.min(Duration.times(wait, 2), LAST_RETRY);
          }
        }
      },
      (effect) => Effect.ignore(effect),
    );

    /** Starts keeping the connector's tokens fresh, in place of what did before. */
    const scheduleRefresh = (id: ConnectorId, tokens: OAuthTokens) =>
      FiberMap.run(refreshers, id)(keepFresh(id, tokens)).pipe(Effect.asVoid);

    /** On unlock, each connector's state from its saved tokens, and its refresh; on lock, nothing can be read. */
    const followVault = vault.status.pipe(
      Stream.map(({ state }) => state === "unlocked"),
      Stream.changes,
      Stream.runForEach((unlocked) =>
        Effect.gen(function* () {
          const ids = yield* connectors.all;
          if (!unlocked) {
            yield* FiberMap.clear(refreshers);
            for (const id of ids) yield* setState(id, Option.some({ _tag: "vault-locked" }));
            return;
          }
          for (const id of ids) {
            const tokens = yield* serially(id)(Effect.andThen(saveHeld(id), secretOf(id))).pipe(
              Effect.map((secret) =>
                Option.flatMap(secret, ({ oauth }) => Option.fromNullOr(oauth?.tokens ?? null)),
              ),
              Effect.orElseSucceed(() => Option.none<OAuthTokens>()),
            );
            if (Option.isNone(tokens)) {
              yield* setState(id, Option.some({ _tag: "needs-sign-in", reason: "not-signed-in" }));
              continue;
            }
            yield* setState(id, Option.some(signedIn(tokens.value)));
            yield* scheduleRefresh(id, tokens.value);
          }
        }),
      ),
    );
    yield* Effect.forkScoped(followVault);

    /** Ends sign-ins whose time is up; none is kept past it. */
    const prune = (now: DateTime.Utc) => {
      for (const [state, sign] of pending) {
        if (!DateTime.isLessThan(now, sign.expiresAt)) pending.delete(state);
      }
    };

    /**
     * The client to sign in with: the one saved when it belongs to this
     * authorization server and may return to `redirectUri`, else a new
     * registration, which is saved with the sign-in for the next. A client
     * registered for loopback serves every loopback port. The operator's
     * client is used as it is; a provider that refuses its redirect says so
     * in the browser.
     */
    const clientFor = Effect.fn("ConnectorAuth.clientFor")(function* (
      id: ConnectorId,
      found: {
        readonly issuer: string;
        readonly metadata: AuthorizationServerMetadata;
        readonly scopes: ReadonlyArray<string>;
      },
      redirectUri: string,
    ) {
      const secret = yield* secretOf(id);
      const saved = Option.flatMap(secret, ({ oauth }) => Option.fromNullOr(oauth?.client ?? null));
      if (Option.isSome(saved)) {
        const client = saved.value;
        if (client.registration === "operator") {
          return sameIssuer(client.issuer, found.issuer) ? client : yield* fail("client-mismatch");
        }
        if (
          sameIssuer(client.issuer, found.issuer) &&
          client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))
        ) {
          return client;
        }
      }
      const endpoint = found.metadata.registration_endpoint;
      const method = chooseAuthMethod(found.metadata);
      if (endpoint === undefined || Option.isNone(method)) {
        return yield* fail("registration-unsupported");
      }
      const registered = yield* withHttp(
        Endpoints.register({
          endpoint,
          redirectUri,
          authMethod: method.value,
          scopes: found.scopes,
        }),
      );
      yield* Effect.logInfo("Registered a connector's OAuth client").pipe(
        Effect.annotateLogs({ connector: id, host: new URL(endpoint).host }),
      );
      return {
        issuer: found.issuer,
        registration: "dynamic",
        clientId: registered.clientId,
        clientSecret: Option.getOrNull(registered.clientSecret),
        authMethod: registered.authMethod,
        redirectUris: registered.redirectUris,
      } satisfies OAuthClient;
    });

    const begin = Effect.fn("ConnectorAuth.begin")(function* (input: {
      readonly connectorId: ConnectorId;
      readonly deviceId: DeviceId;
      readonly redirect: SignInRedirect;
    }) {
      // Taken before anything is asked of a server: a sign-out, a client or
      // another sign-in while this one is prepared replaces it.
      for (const [key, sign] of pending) {
        if (sign.connectorId === input.connectorId) pending.delete(key);
      }
      const generation = nextGeneration(input.connectorId);
      const found = yield* discover(input.connectorId);
      const redirectUri = yield* redirectUriOf(input.redirect, found.issuer);
      const client = yield* clientFor(input.connectorId, found, redirectUri);
      const granted = Option.match(yield* secretOf(input.connectorId), {
        onNone: () => [],
        onSome: ({ oauth }) => oauth?.tokens?.scopes ?? [],
      });
      const extras = yield* connectors.authorizationOf(input.connectorId);
      const verifier = yield* randomText(32);
      const challenge = Base64Url.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)),
      );
      const state = yield* randomText(16);
      // What the server asks for, what its gallery entry adds, what was
      // granted before, and what a call was refused for: a new sign-in loses
      // none of them.
      const scopes = [
        ...new Set([
          ...found.scopes,
          ...extras.scopes,
          ...granted,
          ...(stepUp.get(input.connectorId) ?? []),
        ]),
      ];
      const now = yield* DateTime.now;
      prune(now);
      if (generations.get(input.connectorId) !== generation) {
        return yield* fail("unknown-sign-in");
      }
      const expiresAt = DateTime.addDuration(now, SIGN_IN_LIFETIME);
      pending.set(state, {
        connectorId: input.connectorId,
        deviceId: input.deviceId,
        server: input.redirect._tag === "server",
        redirectUri,
        verifier: Redacted.make(verifier),
        metadata: found.metadata,
        client,
        resource: found.resource,
        scopes,
        expiresAt,
        generation,
      });
      const url = new URL(found.metadata.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);
      url.searchParams.set("resource", found.resource);
      if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
      for (const [name, value] of Object.entries(extras.parameters)) {
        if (!url.searchParams.has(name)) url.searchParams.set(name, value);
      }
      return { authorizationUrl: url.href, expiresAt };
    });

    /**
     * The sign-in an address returns to, taken: a device finishes only what
     * it started, and the server's callback only what returns to it. Another
     * device's attempt leaves the sign-in open for the one that started it.
     */
    const take = Effect.fn("ConnectorAuth.take")(function* (
      params: URLSearchParams,
      by: SignInReturn,
    ) {
      prune(yield* DateTime.now);
      const state = params.get("state");
      const sign = state === null ? undefined : pending.get(state);
      if (state === null || sign === undefined) return yield* fail("unknown-sign-in");
      const allowed =
        by._tag === "callback" ? sign.server : !sign.server && sign.deviceId === by.deviceId;
      if (!allowed) return yield* fail("unknown-sign-in");
      pending.delete(state);
      return sign;
    });

    const complete = Effect.fn("ConnectorAuth.complete")(function* (by: SignInReturn) {
      const text = Redacted.value(by._tag === "callback" ? by.query : by.url).trim();
      let params: URLSearchParams;
      let returnedTo: Option.Option<string> = Option.none();
      if (by._tag === "callback") {
        params = new URLSearchParams(text);
        returnedTo = Option.some(normalPath(by.path));
      } else {
        if (!URL.canParse(text)) return yield* fail("address-mismatch");
        const url = new URL(text);
        params = url.searchParams;
        returnedTo = Option.some(redirectOf(url));
      }
      const sign = yield* take(params, by);
      // The exact address it was sent to return to: the server's callback,
      // on its own origin, by the path of the sign-in's authorization server.
      const expected =
        by._tag === "callback" ? normalPath(new URL(sign.redirectUri).pathname) : sign.redirectUri;
      if (Option.isNone(returnedTo) || returnedTo.value !== expected) {
        return yield* fail("address-mismatch");
      }
      // RFC 9207: the issuer the answer names, when the server sends it or promised to.
      const iss = params.get("iss");
      const issuerOk =
        iss === null
          ? sign.metadata.authorization_response_iss_parameter_supported !== true
          : sameIssuer(iss, sign.client.issuer);
      if (!issuerOk) return yield* fail("issuer-mismatch");
      if (params.has("error")) return yield* fail("denied");
      const code = params.get("code");
      if (code === null || code === "") return yield* fail("address-mismatch");
      const answer = yield* withHttp(
        Endpoints.requestTokens({
          endpoint: sign.metadata.token_endpoint,
          client: tokenClient(sign.client),
          params: [
            ["grant_type", "authorization_code"],
            ["code", code],
            ["redirect_uri", sign.redirectUri],
            ["code_verifier", Redacted.value(sign.verifier)],
          ],
          resource: sign.resource,
        }),
      );
      const now = yield* DateTime.now;
      const tokens = tokensFrom(
        answer,
        now,
        { scopes: sign.scopes, refreshToken: Option.none(), signedInAt: now },
        sign.resource,
      );
      const id = sign.connectorId;
      yield* serially(id)(
        Effect.gen(function* () {
          // A sign-in, client or sign-out since this began has the last word.
          if (generations.get(id) !== sign.generation) return yield* fail("unknown-sign-in");
          // A removed connector is not brought back.
          if (Option.isNone(yield* secretOf(id))) return yield* fail("unknown-connector");
          yield* saveOAuth(id, { client: sign.client, tokens });
          // Tokens a refresh held are older than these.
          held.delete(id);
          // A scope a call was refused for, and this grant still lacks, is asked for again.
          const missing = (stepUp.get(id) ?? []).filter((scope) => !tokens.scopes.includes(scope));
          if (missing.length > 0) stepUp.set(id, missing);
          else stepUp.delete(id);
          yield* setState(id, Option.some(signedIn(tokens)));
          yield* scheduleRefresh(id, tokens);
          yield* PubSub.publish(completed, id);
        }),
      );
      yield* Effect.logInfo("A connector signed in").pipe(
        Effect.annotateLogs({ connector: sign.connectorId }),
      );
      return sign.connectorId;
    });

    const useOperatorClient = Effect.fn("ConnectorAuth.useOperatorClient")(function* (
      id: ConnectorId,
      operator: OperatorClient,
    ) {
      const found = yield* discover(id);
      // The client is for the server the operator registered it at, never
      // one the connector names: its secret goes to no other.
      if (found.issuer !== operator.issuer) return yield* fail("issuer-mismatch");
      const supported = found.metadata.token_endpoint_auth_methods_supported ?? [
        "client_secret_basic",
      ];
      // Basic first: every server takes it for a client with a secret (RFC 6749 §2.3.1).
      const preference: ReadonlyArray<AuthMethod> = Option.isSome(operator.clientSecret)
        ? ["client_secret_basic", "client_secret_post"]
        : ["none"];
      const authMethod = preference.find((method) => supported.includes(method));
      if (authMethod === undefined) return yield* fail("registration-unsupported");
      yield* serially(id)(
        Effect.gen(function* () {
          // A connector removed while its server was asked is not brought back.
          if (Option.isNone(yield* secretOf(id))) return yield* fail("unknown-connector");
          // A sign-in under way with the client this replaces would replace it again.
          for (const [key, sign] of pending) if (sign.connectorId === id) pending.delete(key);
          nextGeneration(id);
          yield* saveOAuth(id, {
            client: {
              issuer: found.issuer,
              registration: "operator",
              clientId: operator.clientId,
              clientSecret: Option.getOrNull(operator.clientSecret),
              authMethod,
              redirectUris: [],
            },
            tokens: null,
          });
          held.delete(id);
          yield* FiberMap.remove(refreshers, id);
          yield* setState(id, Option.some({ _tag: "needs-sign-in", reason: "not-signed-in" }));
        }),
      );
    });

    const accessToken = Effect.fn("ConnectorAuth.accessToken")(function* (id: ConnectorId) {
      const secret = yield* secretOf(id);
      const tokens = Option.flatMap(secret, ({ oauth }) =>
        Option.fromNullOr(oauth?.tokens ?? null),
      );
      if (Option.isNone(tokens)) return yield* fail("not-signed-in");
      if (!expiresWithin(tokens.value, yield* DateTime.now, USE_MARGIN)) {
        return tokens.value.accessToken;
      }
      const renewed = yield* refresh(id, Option.some(USE_MARGIN));
      yield* scheduleRefresh(id, renewed);
      return renewed.accessToken;
    }, Effect.mapError(unavailable));

    /** Whether `token` is the connector's access token now, those a refresh holds first. */
    const isCurrent = Effect.fn("ConnectorAuth.isCurrent")(function* (
      id: ConnectorId,
      token: Redacted.Redacted<string>,
    ) {
      const kept = held.get(id);
      const tokens =
        kept === undefined
          ? Option.flatMap(yield* secretOf(id), ({ oauth }) =>
              Option.fromNullOr(oauth?.tokens ?? null),
            )
          : Option.fromNullOr(kept.tokens);
      return Option.exists(
        tokens,
        ({ accessToken }) => Redacted.value(accessToken) === Redacted.value(token),
      );
    }, Effect.mapError(unavailable));

    const renew = Effect.fn("ConnectorAuth.renew")(function* (id: ConnectorId) {
      yield* scheduleRefresh(id, yield* refresh(id, Option.none()));
    }, Effect.mapError(unavailable));

    const rejected = Effect.fn("ConnectorAuth.rejected")(function* (
      id: ConnectorId,
      wwwAuthenticate: Option.Option<string>,
      sent: Option.Option<Redacted.Redacted<string>>,
    ) {
      // A refusal of a token already replaced says nothing of the current one.
      if (Option.isSome(sent) && !(yield* isCurrent(id, sent.value))) return;
      const challenge = Option.flatMap(wwwAuthenticate, parseBearerChallenge);
      const insufficient = Option.exists(challenge, ({ error }) =>
        Option.contains(error, "insufficient_scope"),
      );
      if (!insufficient) return yield* renew(id);
      // A refresh keeps the scopes granted: only a new sign-in, asking for
      // what the server named, gets more (step-up authorization).
      const needed = Option.flatMap(challenge, ({ scope }) => scope);
      // Added to what earlier calls were refused for, so no call loses its scope to another's.
      if (Option.isSome(needed)) {
        stepUp.set(id, [...new Set([...(stepUp.get(id) ?? []), ...scopesOf(needed.value)])]);
      }
      return yield* new NeedsSignIn();
    });

    const disconnect = Effect.fn("ConnectorAuth.disconnect")(function* (id: ConnectorId) {
      for (const [key, sign] of pending) if (sign.connectorId === id) pending.delete(key);
      stepUp.delete(id);
      nextGeneration(id);
      yield* serially(id)(
        Effect.gen(function* () {
          // Tokens a refresh could not save are the latest grant: they are the ones to revoke.
          const kept = held.get(id);
          const oauth =
            kept === undefined
              ? Option.flatMap(
                  // Without a vault, no connector has secrets to end.
                  yield* secretOf(id).pipe(
                    Effect.catchIf(
                      (error) => error.reason === "vault-not-set-up",
                      () => Effect.succeedNone,
                    ),
                  ),
                  ({ oauth }) => Option.fromNullOr(oauth),
                )
              : Option.some(kept);
          if (Option.isSome(oauth) && oauth.value.tokens !== null) {
            yield* revokeAll(oauth.value.client, oauth.value.tokens).pipe(
              Effect.catch((error) =>
                Effect.logWarning("A connector's tokens could not be revoked").pipe(
                  Effect.annotateLogs({ connector: id, reason: error.reason }),
                ),
              ),
            );
          }
          if (Option.isSome(oauth)) yield* signedOut(id, oauth.value.client, true);
          held.delete(id);
          yield* FiberMap.remove(refreshers, id);
          yield* setState(id, Option.none());
        }),
      );
    });

    /** Revokes the refresh token, which ends the grant, then the access token. */
    const revokeAll = Effect.fn("ConnectorAuth.revokeAll")(function* (
      client: OAuthClient,
      tokens: OAuthTokens,
    ) {
      const metadata = yield* metadataFor(client.issuer);
      const endpoint = metadata.revocation_endpoint;
      if (endpoint === undefined) return;
      const revoke = (token: Redacted.Redacted<string>, hint: "access_token" | "refresh_token") =>
        withHttp(Endpoints.revoke({ endpoint, client: tokenClient(client), token, hint })).pipe(
          Effect.result,
        );
      // Each is asked for whatever became of the other.
      const refreshed =
        tokens.refreshToken === null ? null : yield* revoke(tokens.refreshToken, "refresh_token");
      const access = yield* revoke(tokens.accessToken, "access_token");
      for (const result of [refreshed, access]) {
        if (result !== null && result._tag === "Failure") return yield* result.failure;
      }
    });

    return ConnectorAuth.of({
      begin,
      redirectsFor,
      complete,
      useOperatorClient,
      accessToken,
      rejected,
      disconnect,
      states: SubscriptionRef.changes(states),
      signedIn: Effect.map(PubSub.subscribe(completed), Stream.fromSubscription),
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(SecureRandom.layerWebCrypto, Digest.layerWebCrypto)));

/**
 * The state of a connector these tokens sign. OAuth does not say which
 * account at the service granted them, so none is named.
 */
const signedIn = (tokens: OAuthTokens): SignInState => ({
  _tag: "signed-in",
  account: null,
  signedInAt: tokens.signedInAt,
});

/** Whether the tokens expire within `margin` of `now`; tokens without a lifetime never do. */
const expiresWithin = (tokens: OAuthTokens, now: DateTime.Utc, margin: Duration.Duration) =>
  tokens.expiresAt !== null &&
  !DateTime.isLessThan(now, DateTime.subtractDuration(tokens.expiresAt, margin));

/** A failure that may pass on its own, so a refresh is worth trying again. */
const retryable = (reason: OAuthFailureReason) =>
  reason === "unreachable" || reason === "invalid-response" || reason === "token-refused";

/** What a connector's call is told when its sign-in cannot sign the request. */
const unavailable = (error: OAuthFailure): CredentialsUnavailable => {
  switch (error.reason) {
    case "vault-locked":
      return new VaultLocked();
    case "not-signed-in":
    case "invalid-grant":
    case "invalid-client":
      return new NeedsSignIn();
    default:
      return new AuthFailing({ reason: "refresh-failed" });
  }
};
