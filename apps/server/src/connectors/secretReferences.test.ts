// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- A command connector runs in the system's temporary folder.
import * as NodeOs from "node:os";
import { assert, describe, it } from "@effect/vitest";
import { type FakeMcpServer, fakeMcpServer } from "@j3-bots/connectors/testing";
import { sdkHttpServer } from "@j3-bots/connectors/testing/sdk";
import { eventually, serverEnvironment, STDIO_SERVER } from "@j3-bots/connectors/testing/stdio";
import {
  type BotId,
  CommandId,
  type Connector,
  type ConnectorCommandError,
  type ConnectorGrant,
  ConnectorId,
  EnvName,
  FieldKey,
  HeaderName,
  RegistryName,
  type SecretAccess,
  SecretId,
  SecretName,
} from "@j3-bots/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Bots } from "../bots/Bots.ts";
import { Secrets } from "../secrets/Secrets.ts";
import { reachFakes } from "../testing/connectors.ts";
import * as TestDomain from "../testing/domain.ts";
import { CommandReach, Connectors } from "./Connectors.ts";
import { connectorSecretIdOf } from "./credentials.ts";
import { connectForm } from "./sources/form.ts";

const ID = ConnectorId.make("conn_secretrefs0000001");
const TOKEN_ID = SecretId.make("sec_0000000000000001");
const TOKEN = SecretName.make("tracker-token");
const VALUE = "tracker-value-5c4b3a2918f7";
const NEW_VALUE = "tracker-value-a1b2c3d4e5f6";

const logged: Array<string> = [];
const domain = TestDomain.layer.pipe(
  Layer.provide(reachFakes),
  Layer.provide(
    Layer.succeed(CommandReach, {
      platform: process.platform,
      environment: serverEnvironment,
      cwd: NodeOs.tmpdir(),
      capacity: 4,
      idle: Duration.minutes(1),
      backoff: {
        initial: Duration.millis(100),
        max: Duration.seconds(1),
        stable: Duration.seconds(30),
      },
      restarts: 2,
    }),
  ),
  Layer.provideMerge(
    Layer.merge(
      Logger.layer([Logger.map(Logger.formatJson, (line) => logged.push(line))]),
      Layer.succeed(References.MinimumLogLevel, "All"),
    ),
  ),
);

// A registry entry whose one header is made of two fields side by side.
const SPLIT = RegistryName.make("io.example/split");
const splitForm = connectForm({
  type: "streamable-http",
  url: "https://mcp.split.example/mcp",
  headers: [
    {
      name: "X-Api-Key",
      value: "{prefix}{rest}",
      isRequired: true,
      variables: {
        prefix: { isRequired: true, isSecret: true },
        rest: { isRequired: true, isSecret: true },
      },
    },
  ],
});
if (Result.isFailure(splitForm)) throw new Error(`refused: ${splitForm.failure}`);
const withSplit = TestDomain.layerWithRegistry([
  { name: SPLIT, title: "Split", description: null, form: splitForm.success, owner: null },
]).pipe(Layer.provide(reachFakes));

/** Each test talks to a server over a socket, or to a real process. */
const SLOW = 30_000;

const operator = { _tag: "operator" } as const;
const onlyBots = (...botIds: ReadonlyArray<BotId>): SecretAccess => ({ _tag: "bots", botIds });
const grantTo = (...ids: ReadonlyArray<BotId>): ConnectorGrant => ({ _tag: "bots", ids });

/** Two bots, and the operator's secret, which `access` says who may use. */
const withSecret = (access: (ana: BotId, bea: BotId) => SecretAccess) =>
  Effect.gen(function* () {
    const bots = yield* Bots;
    const ana = yield* bots.create({ commandId: CommandId.make("ana"), draft: { name: "Ana" } });
    const bea = yield* bots.create({ commandId: CommandId.make("bea"), draft: { name: "Bea" } });
    const secrets = yield* Secrets;
    yield* secrets.add({
      id: TOKEN_ID,
      name: TOKEN,
      draft: { _tag: "value", value: Redacted.make(VALUE) },
      access: access(ana.id, bea.id),
    });
    return { ana: ana.id, bea: bea.id, secrets, connectors: yield* Connectors };
  });

/** A remote connector whose one header names the secret, added for `grant`. */
const tracker = (grant: ConnectorGrant) =>
  Effect.gen(function* () {
    const connectors = yield* Connectors;
    return yield* connectors.add({
      id: ID,
      source: {
        _tag: "remote",
        name: "Tracker",
        url: Redacted.make("https://tracker.example/mcp"),
        headers: [
          {
            name: HeaderName.make("Authorization"),
            value: Redacted.make(`Bearer \${secret:${TOKEN}}`),
          },
        ],
        oauthClient: null,
        privateNetwork: false,
      },
      grant,
      by: operator,
    });
  });

/** Points the connector's sealed address at the fake, which the next listing reaches. */
const pointAt = (fake: { readonly url: string }) =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    const sealed = yield* secrets.connectorSecrets.get(connectorSecretIdOf(ID));
    assert.isTrue(Option.isSome(sealed));
    if (Option.isSome(sealed)) {
      yield* secrets.connectorSecrets.put({ ...sealed.value, address: Redacted.make(fake.url) });
    }
  });

/** A fake that answers each call with the `Authorization` header it got, as a server that leaks it would. */
const echoingFake = fakeMcpServer({
  tools: [{ name: "search", description: "Searches issues" }],
  call: (_name, _args, headers) => ({
    _tag: "result",
    text: `asked with ${String(headers.authorization)}`,
  }),
});

/** The connector once `predicate` holds of it. */
const awaitConnector = (predicate: (connector: Connector) => boolean) =>
  Effect.gen(function* () {
    const connectors = yield* Connectors;
    const found = yield* connectors.subscribe.pipe(
      Stream.flatMap((event) =>
        Stream.fromIterable(event._tag === "snapshot" ? event.connectors : event.upsert),
      ),
      Stream.filter(predicate),
      Stream.runHead,
    );
    return Option.getOrThrow(found);
  });

const listed = (connector: Connector) =>
  connector.status._tag === "connected" && connector.tools.length > 0;

const needsSecret = (reason: string) => (connector: Connector) =>
  connector.status._tag === "needs-secret" &&
  connector.status.secret === TOKEN &&
  connector.status.reason === reason;

const refusalOf = (error: ConnectorCommandError): ReadonlyArray<string> | string =>
  error._tag === "SecretRefused" ? [error.secret, error.problem] : error._tag;

/** What reached the fake's server in the `Authorization` header, request by request. */
const authorizations = (fake: FakeMcpServer) =>
  fake.requests.map((request) => String(request.headers.authorization));

describe("references to secrets in a connector's settings", () => {
  it.live(
    "sends a header's reference as the secret's value to the listing and to every bot, and keeps the value from clients, bots and the log",
    () =>
      Effect.gen(function* () {
        logged.length = 0;
        const { ana, bea, secrets, connectors } = yield* withSecret((a, b) => onlyBots(a, b));
        const fake = yield* echoingFake;
        yield* tracker(grantTo(ana, bea));
        yield* pointAt(fake);
        yield* connectors.toolsFor(ana);
        const connector = yield* awaitConnector(listed);

        const answers = [
          yield* connectors.call({ botId: ana, name: "tracker__search", arguments: {} }),
          yield* connectors.call({ botId: bea, name: "tracker__search", arguments: {} }),
        ];
        // The listing and both bots' sessions sent the one resolved value, never the reference.
        assert.isAbove(fake.requests.length, 0);
        for (const sent of authorizations(fake)) assert.strictEqual(sent, `Bearer ${VALUE}`);
        // The server echoed it: the bots read it scrubbed.
        for (const answer of answers) {
          assert.isFalse(answer.isError);
          assert.include(answer.text, "[redacted]");
        }
        const seen = JSON.stringify([
          connector,
          answers,
          yield* connectors.listed,
          yield* connectors.toolsFor(ana),
          logged,
        ]);
        assert.notInclude(seen, VALUE);
        // A call records the bot's use of the secret, where it went.
        const used = (yield* secrets.list).find((secret) => secret.name === TOKEN);
        assert.deepStrictEqual(
          used?.lastUse === null ? null : [used?.lastUse?.botId, used?.lastUse?.use],
          [bea, { _tag: "connector", name: "Tracker" }],
        );
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.live(
    "sends the value with a bot's resources and prompts too, and nothing once the secret is gone",
    () =>
      Effect.gen(function* () {
        const { ana, secrets, connectors } = yield* withSecret((a) => onlyBots(a));
        const fake = yield* sdkHttpServer({ revision: "2026-07-28" });
        yield* tracker(grantTo(ana));
        yield* pointAt(fake);
        yield* connectors.toolsFor(ana);
        yield* awaitConnector(listed);

        const read = yield* connectors.readResource({
          botId: ana,
          slug: "tracker",
          uri: "note://7",
        });
        assert.isFalse(read.isError);
        const prompt = yield* connectors.getPrompt({
          botId: ana,
          slug: "tracker",
          name: "summarize",
          arguments: { topic: "travel" },
        });
        assert.isFalse(prompt.isError);
        assert.isAbove(fake.requests.length, 0);
        for (const request of fake.requests) {
          assert.strictEqual(request.headers.authorization, `Bearer ${VALUE}`);
        }

        yield* secrets.remove(TOKEN_ID);
        yield* awaitConnector(needsSecret("missing"));
        const before = fake.requests.length;
        const refused = yield* connectors.readResource({
          botId: ana,
          slug: "tracker",
          uri: "note://7",
        });
        assert.isTrue(refused.isError);
        assert.strictEqual(fake.requests.length, before);
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.live(
    "opens a new session with a secret's new value",
    () =>
      Effect.gen(function* () {
        const { ana, secrets, connectors } = yield* withSecret((a) => onlyBots(a));
        const fake = yield* echoingFake;
        yield* tracker(grantTo(ana));
        yield* pointAt(fake);
        yield* connectors.toolsFor(ana);
        yield* awaitConnector(listed);
        yield* connectors.call({ botId: ana, name: "tracker__search", arguments: {} });
        const before = fake.requests.length;

        yield* secrets.update({ id: TOKEN_ID, changes: { value: Redacted.make(NEW_VALUE) } });
        // The session the old value opened is not used again: the next call starts another.
        yield* eventually(
          Effect.gen(function* () {
            yield* connectors.call({ botId: ana, name: "tracker__search", arguments: {} });
            return fake.requests
              .slice(before)
              .some(
                (request) =>
                  request.rpc === "initialize" &&
                  request.headers.authorization === `Bearer ${NEW_VALUE}`,
              );
          }),
        );
        assert.notInclude(authorizations(fake).slice(before).join("\n"), "${secret:");
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.live(
    "says which secret is missing and sends nothing until a secret of that name is saved again",
    () =>
      Effect.gen(function* () {
        const { ana, secrets, connectors } = yield* withSecret((a) => onlyBots(a));
        const fake = yield* echoingFake;
        yield* tracker(grantTo(ana));
        yield* pointAt(fake);
        yield* connectors.toolsFor(ana);
        yield* awaitConnector(listed);

        yield* secrets.remove(TOKEN_ID);
        yield* awaitConnector(needsSecret("missing"));
        const before = fake.requests.length;
        assert.deepStrictEqual(yield* connectors.toolsFor(ana), []);
        const answer = yield* connectors.call({
          botId: ana,
          name: "tracker__search",
          arguments: {},
        });
        assert.isTrue(answer.isError);
        assert.include(answer.text, "secret");
        assert.strictEqual(fake.requests.length, before);

        // Saving it again makes the same connector work, with nobody adding it again.
        yield* secrets.add({
          id: SecretId.make("sec_0000000000000002"),
          name: TOKEN,
          draft: { _tag: "value", value: Redacted.make(NEW_VALUE) },
          access: onlyBots(ana),
        });
        yield* awaitConnector(listed);
        assert.deepStrictEqual(
          (yield* connectors.toolsFor(ana)).map((tool) => tool.name),
          ["tracker__search"],
        );
        yield* connectors.call({ botId: ana, name: "tracker__search", arguments: {} });
        assert.strictEqual(authorizations(fake).at(-1), `Bearer ${NEW_VALUE}`);
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.live(
    "stops sending a secret to a connector once a bot it goes to may no longer use it",
    () =>
      Effect.gen(function* () {
        const { ana, bea, secrets, connectors } = yield* withSecret((a, b) => onlyBots(a, b));
        const fake = yield* echoingFake;
        yield* tracker(grantTo(ana, bea));
        yield* pointAt(fake);
        yield* connectors.toolsFor(ana);
        yield* awaitConnector(listed);

        yield* secrets.setAccess(TOKEN_ID, onlyBots(ana));
        yield* awaitConnector(needsSecret("not-shared"));
        const before = fake.requests.length;
        assert.deepStrictEqual(yield* connectors.toolsFor(ana), []);
        assert.isTrue(
          (yield* connectors.call({ botId: ana, name: "tracker__search", arguments: {} })).isError,
        );
        assert.strictEqual(fake.requests.length, before);

        // The operator narrows who uses it, and it works again for the bot that may.
        yield* connectors.setBots({
          commandId: CommandId.make("narrow"),
          connectorId: ID,
          grant: grantTo(ana),
          by: operator,
        });
        yield* awaitConnector(listed);
        assert.isFalse(
          (yield* connectors.call({ botId: ana, name: "tracker__search", arguments: {} })).isError,
        );
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.effect("gives a connector only to bots that may use every secret its settings name", () =>
    Effect.gen(function* () {
      const { ana, bea, secrets, connectors } = yield* withSecret((a) => onlyBots(a));
      // For every bot by default: some bots' secret is not every bot's.
      const everyBot = yield* Effect.flip(tracker({ _tag: "all-bots" }));
      assert.deepStrictEqual(refusalOf(everyBot), [TOKEN, "not-shared"]);
      const both = yield* Effect.flip(tracker(grantTo(ana, bea)));
      assert.deepStrictEqual(refusalOf(both), [TOKEN, "not-shared"]);
      // Nothing of a refused add was kept.
      assert.isTrue(Option.isNone(yield* secrets.connectorSecrets.get(connectorSecretIdOf(ID))));

      yield* tracker(grantTo(ana));
      const widen = (commandId: string) =>
        connectors.setBots({
          commandId: CommandId.make(commandId),
          connectorId: ID,
          grant: grantTo(ana, bea),
          by: operator,
        });
      assert.deepStrictEqual(refusalOf(yield* Effect.flip(widen("widen"))), [TOKEN, "not-shared"]);
      // Once the operator shares the secret, the same change goes through.
      yield* secrets.setAccess(TOKEN_ID, onlyBots(ana, bea));
      const widened = (yield* widen("widen-again")).grant;
      assert.sameMembers(widened._tag === "bots" ? [...widened.ids] : [], [ana, bea]);
    }).pipe(Effect.provide(domain)),
  );

  it.effect(
    "refuses a secret that is missing, a value it lacks, or a reference in the address",
    () =>
      Effect.gen(function* () {
        const { ana, connectors } = yield* withSecret((a) => onlyBots(a));
        const add = (url: string, header: string) =>
          Effect.flip(
            connectors.add({
              id: ID,
              source: {
                _tag: "remote",
                name: "Tracker",
                url: Redacted.make(url),
                headers: [{ name: HeaderName.make("X-Api-Key"), value: Redacted.make(header) }],
                oauthClient: null,
                privateNetwork: false,
              },
              grant: grantTo(ana),
              by: operator,
            }),
          ).pipe(Effect.map(refusalOf));
        const url = "https://tracker.example/mcp";
        assert.deepStrictEqual(yield* add(url, "${secret:nowhere}"), ["nowhere", "missing"]);
        assert.deepStrictEqual(yield* add(url, `\${secret:${TOKEN}.username}`), [
          TOKEN,
          "no-value",
        ]);
        // Percent-encoded, as a form puts a value in an address, or as typed.
        assert.deepStrictEqual(yield* add(`${url}?key=%24%7Bsecret%3A${TOKEN}%7D`, "plain"), [
          TOKEN,
          "in-address",
        ]);
        assert.deepStrictEqual(yield* add(`${url}?key=\${secret:${TOKEN}}`, "plain"), [
          TOKEN,
          "in-address",
        ]);
      }).pipe(Effect.provide(domain)),
  );

  it.effect("lets a bot write only a secret it may use itself into a connector's settings", () =>
    Effect.gen(function* () {
      const { ana, bea, connectors } = yield* withSecret((a) => onlyBots(a));
      // Bea writes Ana's secret into a server for Ana: it would go where Bea chose.
      const refused = yield* Effect.flip(
        connectors.add({
          id: ID,
          source: {
            _tag: "command",
            name: "Notes",
            command: process.execPath,
            args: [Redacted.make(STDIO_SERVER)],
            env: [{ name: EnvName.make("TOKEN"), value: Redacted.make(`\${secret:${TOKEN}}`) }],
          },
          grant: grantTo(ana),
          by: { _tag: "bot", botId: bea },
        }),
      );
      assert.deepStrictEqual(refusalOf(refused), [TOKEN, "not-yours"]);
    }).pipe(Effect.provide(domain)),
  );

  it.live(
    "starts a command's one process with its variables' and arguments' references resolved, and again with a new value",
    () =>
      Effect.gen(function* () {
        logged.length = 0;
        const { ana, bea, secrets, connectors } = yield* withSecret((a, b) => onlyBots(a, b));
        yield* connectors.add({
          id: ID,
          source: {
            _tag: "command",
            name: "Notes",
            command: process.execPath,
            args: [STDIO_SERVER, "--key", `\${secret:${TOKEN}}`].map((arg) => Redacted.make(arg)),
            env: [
              {
                name: EnvName.make("FIXTURE_SECRET"),
                value: Redacted.make(`token=\${secret:${TOKEN}}`),
              },
            ],
          },
          grant: grantTo(ana, bea),
          by: operator,
        });
        const connector = yield* awaitConnector(listed);
        const call = (botId: BotId, name: string, args: Readonly<Record<string, unknown>> = {}) =>
          connectors.call({ botId, name: `notes__${name}`, arguments: args });
        /** The process id `whoami` answers, inside the frame a bot reads it in. */
        const whoami = (botId: BotId) =>
          call(botId, "whoami").pipe(Effect.map((answer) => /\n(\d+)\n/.exec(answer.text)?.[1]));

        // Both bots reach the one process, which was given the value, scrubbed from what it says.
        const pid = yield* whoami(ana);
        assert.isDefined(pid);
        assert.strictEqual(yield* whoami(bea), pid);
        const echoed = yield* call(bea, "echo", { name: "FIXTURE_SECRET" });
        assert.include(echoed.text, "[redacted]");
        assert.notInclude(echoed.text, "${secret:");
        const args = yield* call(ana, "arguments");
        assert.include(args.text, "[redacted]");
        assert.notInclude(args.text, "${secret:");
        assert.notInclude(JSON.stringify([connector, echoed, args, logged]), VALUE);

        // A new value stops the process the old one started; the next use starts another.
        yield* secrets.update({ id: TOKEN_ID, changes: { value: Redacted.make(NEW_VALUE) } });
        yield* eventually(whoami(ana).pipe(Effect.map((now) => now !== undefined && now !== pid)));
        assert.include((yield* call(ana, "echo", { name: "FIXTURE_SECRET" })).text, "[redacted]");
        assert.notInclude(JSON.stringify(logged), NEW_VALUE);
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.live(
    "resolves a bot's session for the bots the connector goes to now, not when the session opened",
    () =>
      Effect.gen(function* () {
        const { ana, bea, secrets, connectors } = yield* withSecret((a, b) => onlyBots(a, b));
        const fake = yield* echoingFake;
        yield* tracker(grantTo(ana, bea));
        yield* pointAt(fake);
        yield* connectors.toolsFor(ana);
        yield* awaitConnector(listed);
        yield* connectors.call({ botId: ana, name: "tracker__search", arguments: {} });

        // The operator keeps the server and the secret for Ana alone, in that order.
        yield* connectors.setBots({
          commandId: CommandId.make("ana-only"),
          connectorId: ID,
          grant: grantTo(ana),
          by: operator,
        });
        yield* secrets.setAccess(TOKEN_ID, onlyBots(ana));
        const answer = yield* connectors.call({
          botId: ana,
          name: "tracker__search",
          arguments: {},
        });
        assert.isFalse(answer.isError);
        assert.strictEqual(authorizations(fake).at(-1), `Bearer ${VALUE}`);
        yield* awaitConnector(listed);
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.live(
    "takes a refused key's new value from the secret it names, with nobody editing the connector",
    () =>
      Effect.gen(function* () {
        const { ana, secrets, connectors } = yield* withSecret((a) => onlyBots(a));
        let accepted = VALUE;
        const fake = yield* fakeMcpServer({
          tools: [{ name: "search", description: "Searches issues" }],
          call: () => ({ _tag: "result", text: "found" }),
          authorize: (authorization) => authorization === `Bearer ${accepted}`,
        });
        yield* tracker(grantTo(ana));
        yield* pointAt(fake);
        yield* connectors.toolsFor(ana);
        yield* awaitConnector(listed);

        // The service ends the key: the connector needs it again.
        accepted = NEW_VALUE;
        yield* connectors.call({ botId: ana, name: "tracker__search", arguments: {} });
        yield* awaitConnector((connector) => connector.status._tag === "needs-sign-in");

        // The operator saves the new key in the secret, and the connector takes it.
        yield* secrets.update({ id: TOKEN_ID, changes: { value: Redacted.make(NEW_VALUE) } });
        yield* awaitConnector(listed);
        assert.deepStrictEqual(
          (yield* connectors.toolsFor(ana)).map((tool) => tool.name),
          ["tracker__search"],
        );
        assert.isFalse(
          (yield* connectors.call({ botId: ana, name: "tracker__search", arguments: {} })).isError,
        );
        assert.strictEqual(authorizations(fake).at(-1), `Bearer ${NEW_VALUE}`);
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );

  it.effect("counts a reference a bot's values make once rendered as the bot's", () =>
    Effect.gen(function* () {
      const { ana, bea, secrets, connectors } = yield* withSecret((_a, b) => onlyBots(b));
      const field = (name: string, text: string) => ({
        key: FieldKey.make(`header:X-Api-Key:${name}`),
        value: Redacted.make(text),
      });
      yield* connectors.add({
        id: ID,
        source: {
          _tag: "listing",
          ref: { _tag: "registry", name: SPLIT },
          language: "en",
          values: [field("prefix", "plain"), field("rest", "key")],
          oauthClient: null,
        },
        grant: grantTo(bea),
        by: operator,
      });
      // Ana writes half a reference into each field of Bea's server: together, Bea's secret.
      const refused = yield* Effect.flip(
        connectors.update({
          connectorId: ID,
          values: [field("prefix", "${secret:"), field("rest", `${TOKEN}}`)],
          by: { _tag: "bot", botId: ana },
        }),
      );
      assert.deepStrictEqual(refusalOf(refused), [TOKEN, "not-yours"]);
      const sealed = Option.getOrThrow(
        yield* secrets.connectorSecrets.get(connectorSecretIdOf(ID)),
      );
      assert.deepStrictEqual(
        sealed.headers.map((header) => Redacted.value(header.value)),
        ["plainkey"],
      );
    }).pipe(Effect.provide(withSplit)),
  );

  it.effect("refuses a bot a reference it may not use even when the settings already hold it", () =>
    Effect.gen(function* () {
      const { ana, bea, connectors } = yield* withSecret((_a, b) => onlyBots(b));
      yield* tracker(grantTo(bea));
      // Ana writes the reference Bea's header already holds into the header again.
      const refused = yield* Effect.flip(
        connectors.update({
          connectorId: ID,
          values: [
            {
              key: FieldKey.make("Authorization"),
              value: Redacted.make(`Token \${secret:${TOKEN}}`),
            },
          ],
          by: { _tag: "bot", botId: ana },
        }),
      );
      assert.deepStrictEqual(refusalOf(refused), [TOKEN, "not-yours"]);
    }).pipe(Effect.provide(domain)),
  );

  it.live(
    "keeps the command as it was when the values given with a new one are refused",
    () =>
      Effect.gen(function* () {
        const { ana, secrets, connectors } = yield* withSecret((a) => onlyBots(a));
        const line = (args: ReadonlyArray<string>) => ({
          command: process.execPath,
          args: [STDIO_SERVER, ...args].map((arg) => Redacted.make(arg)),
          env: [{ name: EnvName.make("FIXTURE_SECRET"), value: Redacted.make("plain-value") }],
        });
        yield* connectors.add({
          id: ID,
          source: { _tag: "command", name: "Notes", ...line([]) },
          grant: grantTo(ana),
          by: operator,
        });
        const refused = yield* Effect.flip(
          connectors.update({
            connectorId: ID,
            command: line(["--tool", "extra"]),
            values: [
              { key: FieldKey.make("FIXTURE_SECRET"), value: Redacted.make("${secret:nowhere}") },
            ],
            by: operator,
          }),
        );
        assert.deepStrictEqual(refusalOf(refused), ["nowhere", "missing"]);
        const sealed = Option.getOrThrow(
          yield* secrets.connectorSecrets.get(connectorSecretIdOf(ID)),
        );
        assert.deepStrictEqual(sealed.command?.args.map(Redacted.value), [STDIO_SERVER]);
      }).pipe(Effect.scoped, Effect.provide(domain)),
    SLOW,
  );
});
