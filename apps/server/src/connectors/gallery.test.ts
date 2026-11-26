// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SESSION_LIMITS, type SessionLimits } from "@j3-bots/connectors";
import { fakeMcpServer } from "@j3-bots/connectors/testing";
import {
  CommandId,
  type CommandError,
  type Connector,
  ConnectorId,
  type ConnectorFieldValue,
  ConnectorGlyph,
  ConnectorOrigin,
  CuratedKey,
  DeviceId,
  FieldKey,
  type OAuthClientInput,
  RegistryName,
} from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Bots } from "../bots/Bots.ts";
import * as TestDomain from "../testing/domain.ts";
import { AS_ORIGIN, TestOAuth } from "../testing/oauth.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { ConnectorReach, Connectors } from "./Connectors.ts";
import { connectorSecretIdOf } from "./credentials.ts";
import { ConnectorAuth } from "./oauth/ConnectorAuth.ts";
import { CURATED, curatedEntry } from "./sources/Curated.ts";
import { connectForm } from "./sources/form.ts";

// Connecting from the gallery, from the add to the removal, for each way a
// curated entry connects: a one-tap sign-in with dynamic registration, the
// operator's own app, and a key in a header. Sign-ins go to the fake
// authorization server, guarding the entry's own address. Tool calls go to a
// fake MCP server on loopback, which the connector's sealed address is
// pointed at once discovery no longer needs it: an entry's real host is
// never reached, since no name resolves here.

const reach = Layer.succeed(ConnectorReach, {
  limits: {
    ...DEFAULT_SESSION_LIMITS,
    guard: {
      ...DEFAULT_SESSION_LIMITS.guard,
      resolve: () => Promise.reject(new Error("no such host")),
    },
  } satisfies SessionLimits,
  loopback: "allow-http",
});

const domain = TestDomain.layer.pipe(Layer.provide(reach));

// A registry entry whose form puts a key in the address's path, a token in
// `Bearer {token}`, and an optional key in a header of its own.
const PATH_KEY = "pk/vault+4f3e2d1c";
const PATH_KEY_ENCODED = encodeURIComponent(PATH_KEY);
const VAULT_TOKEN = "vault-token-first-0001";
const NEW_VAULT_TOKEN = "vault-token-second-0002";
const WORKSPACE_KEY = "workspace-key-0003";
const PATH_FIELD = FieldKey.make("url:path_key");
const VAULT_TOKEN_FIELD = FieldKey.make("header:Authorization:token");
const WORKSPACE_FIELD = FieldKey.make("header:X-Workspace-Key:workspace_key");
const vaultName = RegistryName.make("io.example/vault");
const vaultForm = connectForm({
  type: "streamable-http",
  url: "https://mcp.vault.example/k-{path_key}/mcp",
  variables: { path_key: { isRequired: true, isSecret: true } },
  headers: [
    {
      name: "Authorization",
      value: "Bearer {token}",
      isRequired: true,
      variables: { token: { isRequired: true, isSecret: true } },
    },
    {
      name: "X-Workspace-Key",
      value: "{workspace_key}",
      variables: { workspace_key: { isSecret: true } },
    },
  ],
});
if (Result.isFailure(vaultForm)) throw new Error(`refused: ${vaultForm.failure}`);
const withVault = TestDomain.layerWithRegistry([
  {
    name: vaultName,
    title: "Vault",
    description: null,
    form: vaultForm.success,
    owner: null,
  },
]).pipe(Layer.provide(reach));

const LAPTOP = DeviceId.make("device-laptop");
const KEY = "github_pat_11AAAAAAA0first";
const NEW_KEY = "github_pat_11AAAAAAA0second";
const CLIENT_SECRET = "own-app-secret-value";
const TOKEN_FIELD = FieldKey.make("header:Authorization:token");
const SLOW = 20_000;

const entryUrl = (key: string) => {
  const entry = curatedEntry(CURATED, key);
  if (entry === undefined) throw new Error(`No curated ${key}`);
  return entry.remote.url;
};

const listing = (
  key: string,
  values: ReadonlyArray<ConnectorFieldValue> = [],
  oauthClient: OAuthClientInput | null = null,
) => ({
  _tag: "listing" as const,
  ref: { _tag: "curated" as const, key: CuratedKey.make(key) },
  language: "pt-BR" as const,
  values,
  oauthClient,
});

const value = (key: FieldKey, text: string): ConnectorFieldValue => ({
  key,
  value: Redacted.make(text),
});

/** Makes a bot. */
const setUp = Effect.gen(function* () {
  const bot = yield* (yield* Bots).create({
    commandId: CommandId.make("ana"),
    draft: { name: "Ana" },
  });
  return bot.id;
});

/** The connector's sealed record. */
const secretOf = (id: ConnectorId) =>
  Effect.gen(function* () {
    return yield* (yield* Secrets).connectorSecrets.get(connectorSecretIdOf(id));
  });

/** Points the connector's sealed address at `url`, as its server moved there. */
const pointAt = (id: ConnectorId, url: string) =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    const secret = Option.getOrThrow(yield* secrets.connectorSecrets.get(connectorSecretIdOf(id)));
    yield* secrets.connectorSecrets.put({ ...secret, address: Redacted.make(url) });
  });

/** The connector once `predicate` holds of it, from `connectors.subscribe`. */
const awaitConnector = (id: ConnectorId, predicate: (connector: Connector) => boolean) =>
  Effect.gen(function* () {
    const connectors = yield* Connectors;
    const found = yield* connectors.subscribe.pipe(
      Stream.flatMap((event) =>
        Stream.fromIterable(event._tag === "snapshot" ? event.connectors : event.upsert),
      ),
      Stream.filter((connector) => connector.id === id && predicate(connector)),
      Stream.runHead,
    );
    return Option.getOrThrow(found);
  });

/** Signs in through the browser, coming back to `redirect`; `before` runs between begin and return. */
const signIn = <E = never, R = never>(
  id: ConnectorId,
  redirect: { readonly _tag: "relay"; readonly port: number } | { readonly _tag: "paste" },
  before?: Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const auth = yield* ConnectorAuth;
    const fake = yield* TestOAuth;
    const { authorizationUrl } = yield* auth.begin({ connectorId: id, deviceId: LAPTOP, redirect });
    const back = fake.authorize(authorizationUrl);
    if (before !== undefined) yield* before;
    yield* auth.complete({ _tag: "device", deviceId: LAPTOP, url: Redacted.make(back) });
    return new URL(authorizationUrl);
  });

const invalidReason = (error: CommandError) => (error._tag === "Invalid" ? error.reason : null);

/** Every way a secret could reach a client or a bot: what they are sent. */
const shown = (...values: ReadonlyArray<unknown>) => JSON.stringify(values);

describe("connecting from the gallery", () => {
  it.live(
    "signs in to a one-tap entry with a client it registers once, renews its token, and signs out",
    () =>
      Effect.gen(function* () {
        const ana = yield* setUp;
        const fake = yield* TestOAuth;
        fake.guard(entryUrl("notion"));
        // A token that expires within the minute is renewed before each use.
        fake.options = { ...fake.options, lifetime: 30 };
        const connectors = yield* Connectors;
        const id = ConnectorId.make("conn_gallerynotion0001");

        const added = yield* connectors.add({
          id,
          source: listing("notion"),
          grant: { _tag: "all-bots" },
          by: { _tag: "operator" },
        });
        assert.deepStrictEqual(
          {
            name: added.name,
            glyph: added.glyph,
            listing: added.listing,
            publisher: added.publisher,
            transport: added.transport,
            signIn: added.signIn,
            status: added.status,
          },
          {
            name: "Notion",
            glyph: ConnectorGlyph.make("notebook"),
            listing: { _tag: "curated", key: CuratedKey.make("notion") },
            publisher: { _tag: "domain", domain: "notion.com" },
            transport: { _tag: "remote", origin: ConnectorOrigin.make("https://mcp.notion.com") },
            signIn: "oauth",
            status: { _tag: "needs-sign-in", reason: "not-signed-in" },
          },
        );
        const sealed = Option.getOrThrow(yield* secretOf(id));
        assert.strictEqual(sealed.address && Redacted.value(sealed.address), entryUrl("notion"));

        const mcp = yield* fakeMcpServer({
          tools: [{ name: "search", description: "Searches pages" }],
          call: () => ({ _tag: "result", text: "2 pages" }),
          authorize: (authorization) =>
            Option.exists(
              fake.bearer,
              (token) => authorization === `Bearer ${Redacted.value(token)}`,
            ),
        });

        // The desktop app relays each sign-in from a port of its own: the
        // second reuses the client the first registered.
        yield* signIn(id, { _tag: "relay", port: 41234 });
        const second = yield* signIn(id, { _tag: "relay", port: 52525 }, pointAt(id, mcp.url));
        assert.strictEqual(
          second.searchParams.get("redirect_uri")?.startsWith("http://127.0.0.1:52525/"),
          true,
        );
        const registrations = fake.received.filter(
          (request) => request.url === `${AS_ORIGIN}/register`,
        );
        assert.strictEqual(registrations.length, 1);

        const signedIn = fake.issued.filter((token) => token.startsWith("access")).length;
        yield* connectors.toolsFor(ana);
        yield* awaitConnector(
          id,
          (connector) => connector.status._tag === "connected" && connector.tools.length > 0,
        );
        const answer = yield* connectors.call({
          botId: ana,
          name: "notion__search",
          arguments: {},
        });
        assert.include(answer.text, "2 pages");
        // Renewed before its use: the server was sent a token issued after the sign-in.
        const access = fake.issued.filter((token) => token.startsWith("access"));
        assert.isAbove(access.length, signedIn);
        const last = mcp.requests.at(-1)?.headers.authorization;
        assert.strictEqual(last, `Bearer ${access.at(-1)}`);

        yield* connectors.remove({ commandId: CommandId.make("remove-notion"), connectorId: id });
        assert.isTrue(fake.revoked.some((token) => token.startsWith("refresh")));
        assert.isTrue(Option.isNone(yield* secretOf(id)));
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.live(
    "signs in to an own-app entry with the operator's client, its scopes and its app's parameters",
    () =>
      Effect.gen(function* () {
        yield* setUp;
        const fake = yield* TestOAuth;
        fake.guard(entryUrl("google-gmail"));
        fake.addClient("own-app-client", CLIENT_SECRET);
        const connectors = yield* Connectors;
        const id = ConnectorId.make("conn_gallerygmail00001");

        const withoutClient = yield* Effect.flip(
          connectors.add({ id, source: listing("google-gmail"), by: { _tag: "operator" } }),
        );
        assert.strictEqual(invalidReason(withoutClient), "connector-fields");

        const added = yield* connectors.add({
          id,
          source: listing("google-gmail", [], {
            issuer: fake.issuer,
            clientId: "own-app-client",
            clientSecret: Redacted.make(CLIENT_SECRET),
          }),
          by: { _tag: "operator" },
        });
        assert.strictEqual(added.signIn, "oauth");

        const url = yield* signIn(id, { _tag: "paste" });
        assert.strictEqual(url.searchParams.get("client_id"), "own-app-client");
        assert.strictEqual(url.searchParams.get("access_type"), "offline");
        assert.strictEqual(url.searchParams.get("prompt"), "consent");
        const entry = curatedEntry(CURATED, "google-gmail");
        const scopes = (url.searchParams.get("scope") ?? "").split(" ");
        if (entry?.connect.kind !== "own-app") throw new Error("Gmail is an own-app entry");
        for (const scope of entry.connect.scopes) assert.include(scopes, scope);
        // Nothing registered: the operator's client is the one.
        assert.isFalse(fake.received.some((request) => request.url === `${AS_ORIGIN}/register`));

        const connector = yield* awaitConnector(id, (found) => found.signedInAt !== null);
        assert.notInclude(shown(connector), CLIENT_SECRET);
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.live(
    "connects a key entry, sends its key in its header, and takes a new one after a refusal",
    () =>
      Effect.gen(function* () {
        const ana = yield* setUp;
        const connectors = yield* Connectors;
        const id = ConnectorId.make("conn_gallerygithub0001");
        let accepted = KEY;
        const mcp = yield* fakeMcpServer({
          tools: [{ name: "issues", description: "Lists issues" }],
          call: () => ({ _tag: "result", text: "4 issues" }),
          authorize: (authorization) => authorization === `Bearer ${accepted}`,
        });

        const added = yield* connectors.add({
          id,
          source: listing("github", [value(TOKEN_FIELD, KEY)]),
          grant: { _tag: "all-bots" },
          by: { _tag: "operator" },
        });
        assert.strictEqual(added.signIn, "fields");
        // The key's field, in the operator's language, to give it again.
        assert.deepStrictEqual(
          added.fields.map((field) => [field.key, field.label, field.secret]),
          [[TOKEN_FIELD, "Token de acesso pessoal refinado", true]],
        );
        const sealed = Option.getOrThrow(yield* secretOf(id));
        assert.deepStrictEqual(
          sealed.headers.map((header) => [header.name, Redacted.value(header.value)]),
          [["Authorization", `Bearer ${KEY}`]],
        );
        assert.strictEqual(sealed.address && Redacted.value(sealed.address), entryUrl("github"));

        yield* pointAt(id, mcp.url);
        const issues = { botId: ana, name: "github__issues", arguments: {} };
        yield* connectors.toolsFor(ana);
        yield* awaitConnector(id, (connector) => connector.tools.length > 0);
        assert.include((yield* connectors.call(issues)).text, "4 issues");

        // The service refuses the key: the operator gives a new one through the same field.
        accepted = NEW_KEY;
        assert.isTrue((yield* connectors.call(issues)).isError);
        yield* awaitConnector(
          id,
          (connector) =>
            connector.status._tag === "needs-sign-in" && connector.status.reason === "rejected",
        );
        const outside = yield* Effect.flip(
          connectors.update({
            by: { _tag: "operator" },
            connectorId: id,
            values: [value(FieldKey.make("url:host"), "x")],
          }),
        );
        assert.strictEqual(invalidReason(outside), "connector-fields");
        const updated = yield* connectors.update({
          by: { _tag: "operator" },
          connectorId: id,
          values: [value(TOKEN_FIELD, NEW_KEY)],
        });
        assert.include((yield* connectors.call(issues)).text, "4 issues");
        assert.strictEqual(mcp.requests.at(-1)?.headers.authorization, `Bearer ${NEW_KEY}`);
        const seen = shown(added, updated, yield* connectors.toolsFor(ana));
        assert.notInclude(seen, KEY);
        assert.notInclude(seen, NEW_KEY);

        yield* connectors.remove({ commandId: CommandId.make("remove-github"), connectorId: id });
        assert.isTrue(Option.isNone(yield* secretOf(id)));
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );
  it.live(
    "keeps every key of an entry's form out of what its server says, and never signs in with one in its address",
    () =>
      Effect.gen(function* () {
        const ana = yield* setUp;
        const fake = yield* TestOAuth;
        const connectors = yield* Connectors;
        const id = ConnectorId.make("conn_galleryvault00001");
        const source = (oauthClient: OAuthClientInput | null) => ({
          _tag: "listing" as const,
          ref: { _tag: "registry" as const, name: vaultName },
          language: "en" as const,
          values: [value(PATH_FIELD, PATH_KEY), value(VAULT_TOKEN_FIELD, VAULT_TOKEN)],
          oauthClient,
        });
        let accepted = VAULT_TOKEN;
        const mcp = yield* fakeMcpServer({
          // The server says the key of its path back, as given and URL-encoded.
          tools: [{ name: "search", description: `Searches ${PATH_KEY} at ${PATH_KEY_ENCODED}` }],
          // And every key a request carried, as it was made from them.
          call: (_name, _args, headers) => ({
            _tag: "result",
            text: [
              "found",
              (headers.authorization ?? "").replace("Bearer ", ""),
              headers["x-workspace-key"] ?? "",
              PATH_KEY,
              PATH_KEY_ENCODED,
            ].join(" "),
          }),
          authorize: (authorization) => authorization === `Bearer ${accepted}`,
        });

        // A key entry signs in with its form: a client cannot make it sign in with OAuth.
        const withClient = yield* Effect.flip(
          connectors.add({
            id,
            source: source({
              issuer: fake.issuer,
              clientId: "client",
              clientSecret: null,
            }),
            grant: { _tag: "all-bots" },
            by: { _tag: "operator" },
          }),
        );
        assert.strictEqual(invalidReason(withClient), "connector-fields");

        // Added with the optional workspace key left blank.
        const added = yield* connectors.add({
          id,
          source: source(null),
          grant: { _tag: "all-bots" },
          by: { _tag: "operator" },
        });
        assert.strictEqual(added.signIn, "fields");
        assert.deepStrictEqual(
          Option.getOrThrow(yield* secretOf(id)).headers.map((header) => header.name),
          ["Authorization"],
        );
        // So no sign-in begins, and nothing of its address reaches an authorization server.
        yield* Effect.flip(
          (yield* ConnectorAuth).begin({
            connectorId: id,
            deviceId: LAPTOP,
            redirect: { _tag: "paste" },
          }),
        );
        assert.deepStrictEqual(fake.received, []);

        yield* pointAt(id, mcp.url);
        const search = { botId: ana, name: "vault__search", arguments: {} };
        yield* connectors.toolsFor(ana);
        const listed = yield* awaitConnector(id, (connector) => connector.tools.length > 0);
        const first = yield* connectors.call(search);
        assert.include(first.text, "found");
        assert.include(first.text, "[redacted]");
        for (const secret of [PATH_KEY, PATH_KEY_ENCODED, VAULT_TOKEN]) {
          assert.notInclude(shown(listed, first, yield* connectors.toolsFor(ana)), secret);
        }

        // A new token, and the workspace key first given now: both are sent and both kept out.
        accepted = NEW_VAULT_TOKEN;
        mcp.setTools([
          { name: "search", description: `Searches ${PATH_KEY} at ${PATH_KEY_ENCODED}` },
          { name: "whoami", description: `Signed in as ${NEW_VAULT_TOKEN} in ${WORKSPACE_KEY}` },
        ]);
        yield* connectors.update({
          by: { _tag: "operator" },
          connectorId: id,
          values: [
            value(VAULT_TOKEN_FIELD, NEW_VAULT_TOKEN),
            value(WORKSPACE_FIELD, WORKSPACE_KEY),
          ],
        });
        const second = yield* connectors.call(search);
        assert.include(second.text, "found");
        const sent = mcp.requests.at(-1)?.headers;
        assert.strictEqual(sent?.authorization, `Bearer ${NEW_VAULT_TOKEN}`);
        assert.strictEqual(sent?.["x-workspace-key"], WORKSPACE_KEY);
        const reviewed = yield* awaitConnector(id, (connector) => connector.review !== null);
        for (const secret of [PATH_KEY, PATH_KEY_ENCODED, NEW_VAULT_TOKEN, WORKSPACE_KEY]) {
          assert.notInclude(shown(second, reviewed, yield* connectors.toolsFor(ana)), secret);
        }
      }).pipe(Effect.scoped, Effect.provide(withVault)),
    SLOW,
  );
});
