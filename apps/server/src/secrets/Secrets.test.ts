// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import {
  type BotId,
  DeviceId,
  Label,
  type SecretAccess,
  SecretId,
  SecretName,
  type SecretDraft,
  SiteOrigin,
} from "@j3-bots/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Domain from "../domain.ts";
import * as TestDomain from "../testing/domain.ts";
import { createBot } from "../testing/turns.ts";
import { ConnectorId, type ConnectorSecret, connectorRecordId } from "./ConnectorSecret.ts";
import { oldVault, onSecretsFile, sealed, secretsFolder } from "../testing/secrets.ts";
import { referencesIn } from "./references.ts";
import { Secrets } from "./Secrets.ts";
import { KEY_FILE } from "./store.ts";

const DEVICE = DeviceId.make("device-laptop");

const idOf = (n: number) => SecretId.make(`sec_${String(n).padStart(16, "0")}`);
const name = SecretName.make;

const login = (password: string): SecretDraft => ({
  _tag: "login",
  origins: [SiteOrigin.make("https://example.com")],
  username: Redacted.make("ana@example.com"),
  password: Redacted.make(password),
  totp: Redacted.make("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"),
});

const value = (text: string): SecretDraft => ({ _tag: "value", value: Redacted.make(text) });

const everyBot = { _tag: "every-bot" } as const;
const onlyBots = (...botIds: ReadonlyArray<BotId>) => ({ _tag: "bots", botIds }) as const;

const CONNECTOR = ConnectorId.make("notion");
const connectorSecret: ConnectorSecret = {
  connectorId: CONNECTOR,
  address: Redacted.make("https://mcp.example/mcp?key=address-key-value"),
  oauth: {
    client: {
      issuer: "https://auth.example",
      registration: "dynamic",
      clientId: "client-1",
      clientSecret: null,
      authMethod: "none",
      redirectUris: ["http://127.0.0.1/oauth/callback"],
    },
    tokens: {
      accessToken: Redacted.make("access-token-value"),
      refreshToken: Redacted.make("refresh-token-value"),
      expiresAt: null,
      scopes: ["read"],
      resource: "https://mcp.example/mcp",
      signedInAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    },
  },
  headers: [{ name: "X-Api-Key", value: Redacted.make("header-value") }],
  command: null,
  env: [],
  formSecrets: [],
  formValues: [],
  service: null,
};

/** The secrets' state now. */
const stateNow = Effect.gen(function* () {
  const secrets = yield* Secrets;
  return Option.getOrThrow(yield* Stream.runHead(secrets.status)).state;
});

/** The reason a refused request gives, or null when it was not refused. */
const refusal = <A, E>(exit: Exit.Exit<A, E>): string | null => {
  if (Exit.isSuccess(exit)) return null;
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error)) return "defect";
  const found: unknown = error.value;
  if (typeof found === "object" && found !== null && "reason" in found) {
    return String(found.reason);
  }
  return typeof found === "object" && found !== null && "_tag" in found
    ? String(found._tag)
    : "unknown";
};

/** The key file's path. */
const keyFile = Effect.map(secretsFolder, (folder) => `${folder}/${KEY_FILE}`);

/** The data key the key file holds. */
const keyOfFile = Effect.gen(function* () {
  const text = yield* (yield* FileSystem.FileSystem).readFileString(yield* keyFile);
  return Buffer.from(text.split("\n")[1] ?? "", "base64");
}).pipe(Effect.orDie);

/** Seals `plain` as a record's field under `key`, in place of the value it had. */
const sealInto = (key: Uint8Array, recordId: string, field: string, plain: string) => {
  const row = sealed(key, recordId, field, plain);
  return onSecretsFile(
    (sql) => sql`
      UPDATE record_fields SET nonce = ${row.nonce}, sealed = ${row.sealed}
      WHERE record_id = ${recordId} AND field = ${field}
    `,
  );
};

it.effect("keeps secrets sealed under the key file's key, open from the server's start", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const secrets = yield* Secrets;
      assert.strictEqual(yield* stateNow, "ready");
      yield* secrets.add({
        id: idOf(1),
        name: name("example"),
        draft: login("hunter2"),
        access: everyBot,
      });
      yield* secrets.add({
        id: idOf(2),
        name: name("weather-api"),
        draft: value("weather-token-value"),
        access: everyBot,
      });
      const password = yield* secrets.reveal({ id: idOf(1), field: "password", deviceId: DEVICE });
      assert.strictEqual(Redacted.value(password), "hunter2");
    }).pipe(Effect.provide(Domain.layer));

    // A restart asks for nothing.
    yield* Effect.gen(function* () {
      const secrets = yield* Secrets;
      assert.strictEqual(yield* stateNow, "ready");
      const listed = yield* secrets.list;
      assert.deepStrictEqual(
        listed.map((secret) => secret.name),
        ["example", "weather-api"],
      );
      assert.deepStrictEqual(listed[0]?.kind, {
        _tag: "login",
        origins: [SiteOrigin.make("https://example.com")],
        hasTotp: true,
      });
      assert.deepStrictEqual(listed[1]?.kind, { _tag: "value" });
      assert.deepStrictEqual(listed[0]?.lastReveal?.deviceId, DEVICE);
      const token = yield* secrets.reveal({ id: idOf(2), field: "value", deviceId: DEVICE });
      assert.strictEqual(Redacted.value(token), "weather-token-value");
    }).pipe(Effect.provide(Domain.layer));

    // Nothing in the file is a value.
    const stored = JSON.stringify(yield* onSecretsFile((sql) => sql`SELECT * FROM record_fields`));
    for (const plain of ["hunter2", "ana@example.com", "weather-token-value"]) {
      assert.notInclude(stored, plain);
    }
    // The key file and its folder are the server user's alone. On Windows a
    // file has no such mode: they take the private home's list.
    if (process.platform !== "win32") {
      const fs = yield* FileSystem.FileSystem;
      assert.strictEqual(Number((yield* fs.stat(yield* keyFile)).mode) & 0o777, 0o600);
      assert.strictEqual(Number((yield* fs.stat(yield* secretsFolder)).mode) & 0o777, 0o700);
    }
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect(
  "refuses to start over a vault from before secrets that holds something, and changes nothing",
  () =>
    Effect.gen(function* () {
      yield* oldVault(["cred_0000000000000001"]);
      const before = yield* onSecretsFile((sql) => sql`SELECT * FROM keyring`);
      const refused = yield* Effect.flip(stateNow.pipe(Effect.provide(Domain.layer)));
      assert.strictEqual(refused._tag, "OldVaultUnopened");
      assert.include(refused.message, "Open it with J3 Bots 0.12 first");
      assert.deepStrictEqual(yield* onSecretsFile((sql) => sql`SELECT * FROM keyring`), before);
      assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(yield* keyFile));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("replaces an empty vault from before secrets with a key file", () =>
  Effect.gen(function* () {
    yield* oldVault([]);
    yield* Effect.gen(function* () {
      assert.strictEqual(yield* stateNow, "ready");
      yield* (yield* Secrets).add({
        id: idOf(1),
        name: name("example"),
        draft: login("hunter2"),
        access: everyBot,
      });
    }).pipe(Effect.provide(Domain.layer));
    assert.deepStrictEqual(yield* onSecretsFile((sql) => sql`SELECT * FROM keyring`), []);
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect(
  "says the secrets are unreadable while their key file is gone or another, and changes nothing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.gen(function* () {
        yield* (yield* Secrets).add({
          id: idOf(1),
          name: name("example"),
          draft: login("hunter2"),
          access: everyBot,
        });
      }).pipe(Effect.provide(Domain.layer));
      const original = yield* fs.readFileString(yield* keyFile);
      const before = yield* onSecretsFile((sql) => sql`SELECT * FROM record_fields`);

      yield* fs.remove(yield* keyFile);
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* stateNow, "unreadable");
        assert.strictEqual(
          refusal(yield* Effect.exit((yield* Secrets).list)),
          "secrets-unavailable",
        );
      }).pipe(Effect.provide(Domain.layer));
      // No new key was made over the secrets sealed under the lost one.
      assert.isFalse(yield* fs.exists(yield* keyFile));

      const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
      yield* fs.writeFileString(yield* keyFile, `j3-bots secrets key v1\n${other}\n`);
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* stateNow, "unreadable");
      }).pipe(Effect.provide(Domain.layer));

      // The right key back, and all is as it was.
      yield* fs.writeFileString(yield* keyFile, original);
      yield* Effect.gen(function* () {
        assert.strictEqual(yield* stateNow, "ready");
        assert.strictEqual((yield* (yield* Secrets).list).length, 1);
      }).pipe(Effect.provide(Domain.layer));
      assert.deepStrictEqual(
        yield* onSecretsFile((sql) => sql`SELECT * FROM record_fields`),
        before,
      );
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect(
  "gives references their values only for a connector every one of whose bots may use them",
  () =>
    Effect.gen(function* () {
      const secrets = yield* Secrets;
      const ana = yield* createBot("Ana");
      const bruno = yield* createBot("Bruno");
      yield* secrets.add({
        id: idOf(1),
        name: name("weather-api"),
        draft: value("weather-token-value"),
        access: onlyBots(ana.id),
      });
      yield* secrets.add({
        id: idOf(2),
        name: name("example"),
        draft: login("hunter2"),
        access: everyBot,
      });
      const reference = (text: string) => {
        const [found] = referencesIn(text);
        if (found === undefined) return assert.fail(`${text} is no reference`);
        return found;
      };
      const valuesFor = (users: SecretAccess, ...texts: ReadonlyArray<string>) =>
        secrets.referenceValues({ references: texts.map(reference), users }).pipe(
          Effect.map((values) =>
            Object.fromEntries([...values].map(([text, value]) => [text, Redacted.value(value)])),
          ),
          Effect.exit,
        );

      assert.deepStrictEqual(
        yield* valuesFor(onlyBots(ana.id), "${secret:weather-api}"),
        Exit.succeed({ "${secret:weather-api}": "weather-token-value" }),
      );
      // A login's bare reference is its password; every bot may use this one, those to come too.
      assert.deepStrictEqual(
        yield* valuesFor(everyBot, "${secret:example.username}", "${secret:example}"),
        Exit.succeed({
          "${secret:example.username}": "ana@example.com",
          "${secret:example}": "hunter2",
        }),
      );

      const refused = (exit: Exit.Exit<unknown, unknown>) => {
        const reason = refusal(exit);
        if (Exit.isFailure(exit)) {
          // A refusal names the secret, never a value.
          assert.notInclude(Cause.pretty(exit.cause), "weather-token-value");
          assert.notInclude(Cause.pretty(exit.cause), "hunter2");
        }
        return reason;
      };
      // One bot of the connector that may not use it refuses it for all of them.
      assert.strictEqual(
        refused(yield* valuesFor(onlyBots(ana.id, bruno.id), "${secret:weather-api}")),
        "not-allowed",
      );
      // Some bots' secret is not every bot's, whoever those are now.
      assert.strictEqual(
        refused(yield* valuesFor(everyBot, "${secret:weather-api}")),
        "not-allowed",
      );
      assert.strictEqual(refused(yield* valuesFor(everyBot, "${secret:nowhere}")), "missing");
      assert.strictEqual(
        refused(yield* valuesFor(onlyBots(ana.id), "${secret:weather-api.password}")),
        "no-value",
      );
      // Looking up records no use: a bot's call does.
      const used = (yield* secrets.list).find((secret) => secret.name === "weather-api");
      assert.isNull(used?.lastUse ?? null);
      const use = { _tag: "connector", name: Label.make("Weather") } as const;
      yield* secrets.noteUse({ names: [name("weather-api"), name("nowhere")], botId: ana.id, use });
      const weather = (yield* secrets.list).find((secret) => secret.name === "weather-api");
      assert.deepStrictEqual(
        weather?.lastUse === null ? null : [weather?.lastUse?.botId, weather?.lastUse?.use],
        [ana.id, use],
      );

      // The operator widens it, and the same reference works for both bots.
      yield* secrets.setAccess(idOf(1), onlyBots(ana.id, bruno.id));
      assert.deepStrictEqual(
        yield* valuesFor(onlyBots(ana.id, bruno.id), "${secret:weather-api}"),
        Exit.succeed({ "${secret:weather-api}": "weather-token-value" }),
      );
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect(
  "answers a bot's tool that holds the main database while a device lists the secrets",
  () =>
    Effect.gen(function* () {
      const secrets = yield* Secrets;
      const sql = yield* SqlClient.SqlClient;
      const ana = yield* createBot("Ana");
      yield* secrets.add({
        id: idOf(1),
        name: name("weather-api"),
        draft: value("weather-token-value"),
        access: onlyBots(ana.id),
      });
      // Settings lists the secrets, which reads the bots from the main
      // database, while a bot's tool holds that database's transaction and
      // reads a secret in it, as `ask_for_secret` does.
      const inTransaction = yield* Deferred.make<void>();
      const listing = yield* Effect.forkChild(
        Deferred.await(inTransaction).pipe(Effect.andThen(secrets.list)),
      );
      const found = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* Deferred.succeed(inTransaction, undefined);
          for (let step = 0; step < 10; step++) yield* Effect.yieldNow;
          return { secret: yield* secrets.named(name("weather-api")), listing };
        }),
      );
      assert.strictEqual(Option.getOrNull(found.secret)?.name, "weather-api");
      assert.lengthOf(yield* Fiber.join(found.listing), 1);
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("keeps a secret's name its own, and its kind's fields", () =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    yield* secrets.add({
      id: idOf(1),
      name: name("example"),
      draft: login("hunter2"),
      access: everyBot,
    });
    const again = yield* secrets.add({
      id: idOf(1),
      name: name("example"),
      draft: login("hunter2"),
      access: everyBot,
    });
    // The same id again, as after a lost reply, adds nothing.
    assert.isFalse(again.created);
    assert.strictEqual(
      refusal(
        yield* Effect.exit(
          secrets.add({ id: idOf(2), name: name("example"), draft: value("x"), access: everyBot }),
        ),
      ),
      "secret-name-taken",
    );
    yield* secrets.add({ id: idOf(2), name: name("token"), draft: value("x"), access: everyBot });
    assert.strictEqual(
      refusal(
        yield* Effect.exit(secrets.update({ id: idOf(2), changes: { name: name("example") } })),
      ),
      "secret-name-taken",
    );
    assert.strictEqual(
      refusal(
        yield* Effect.exit(
          secrets.update({ id: idOf(2), changes: { password: Redacted.make("not for a value") } }),
        ),
      ),
      "secret-kind",
    );
    const renamed = yield* secrets.update({
      id: idOf(2),
      changes: { name: name("weather-api"), value: Redacted.make("new-token-value") },
    });
    assert.strictEqual(renamed.name, "weather-api");
    assert.isTrue(Option.isNone(yield* secrets.named(name("token"))));
    const token = yield* secrets.reveal({ id: idOf(2), field: "value", deviceId: DEVICE });
    assert.strictEqual(Redacted.value(token), "new-token-value");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a sealed value moved to another secret or field", () =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    yield* secrets.add({
      id: idOf(1),
      name: name("first"),
      draft: login("first secret"),
      access: everyBot,
    });
    yield* secrets.add({
      id: idOf(2),
      name: name("second"),
      draft: login("second secret"),
      access: everyBot,
    });

    // The second login's password, sealed for it, copied over the first's.
    yield* onSecretsFile(
      (sql) => sql`
        UPDATE record_fields
        SET (nonce, sealed) = (
          SELECT nonce, sealed FROM record_fields
          WHERE record_id = ${idOf(2)} AND field = 'password'
        )
        WHERE record_id = ${idOf(1)} AND field = 'password'
      `,
    );
    const moved = yield* Effect.exit(
      secrets.reveal({ id: idOf(1), field: "password", deviceId: DEVICE }),
    );
    assert.strictEqual(refusal(moved), "secrets-damaged");

    // Within one login: its user name's seal in its password's place.
    yield* onSecretsFile(
      (sql) => sql`
        UPDATE record_fields
        SET (nonce, sealed) = (
          SELECT nonce, sealed FROM record_fields
          WHERE record_id = ${idOf(2)} AND field = 'username'
        )
        WHERE record_id = ${idOf(2)} AND field = 'password'
      `,
    );
    const swapped = yield* Effect.exit(
      secrets.reveal({ id: idOf(2), field: "password", deviceId: DEVICE }),
    );
    assert.strictEqual(refusal(swapped), "secrets-damaged");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a value that opens but does not read back, and shows it nowhere", () => {
  const logged: Array<string> = [];
  const MARKER = "plain-value-marker";
  return Effect.gen(function* () {
    const secrets = yield* Secrets;
    yield* secrets.add({
      id: idOf(1),
      name: name("example"),
      draft: login("hunter2"),
      access: everyBot,
    });
    yield* secrets.connectorSecrets.put(connectorSecret);
    const key = yield* keyOfFile;
    const connector = connectorRecordId(CONNECTOR);
    // Sealed under the secrets' own key, for the right record and field, in a shape it is not.
    yield* sealInto(key, idOf(1), "totp", JSON.stringify({ secret: MARKER }));
    yield* sealInto(key, connector, "oauth", JSON.stringify({ accessToken: MARKER }));

    const exits: Array<Exit.Exit<unknown, unknown>> = [
      yield* Effect.exit(secrets.reveal({ id: idOf(1), field: "totp", deviceId: DEVICE })),
      yield* Effect.exit(secrets.totpPreview(idOf(1))),
      yield* Effect.exit(secrets.connectorSecrets.get(CONNECTOR)),
    ];
    // Origins that are not origins, which the list reads for every login.
    yield* sealInto(key, idOf(1), "origins", JSON.stringify([MARKER]));
    exits.push(yield* Effect.exit(secrets.list));

    for (const exit of exits) {
      assert.strictEqual(refusal(exit), "secrets-damaged");
      if (Exit.isFailure(exit)) assert.notInclude(Cause.pretty(exit.cause), MARKER);
    }
    const logs = logged.join("\n");
    assert.notInclude(logs, MARKER);
    assert.include(logs, connector);
  }).pipe(
    Effect.provide(
      Layer.merge(
        TestDomain.layer,
        Logger.layer([
          Logger.map(Logger.formatJson, (line) => {
            logged.push(line);
          }),
        ]),
      ),
    ),
  );
});

it.effect("leaves secrets a newer release changed as they were, and refuses to use them", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      yield* (yield* Secrets).add({
        id: idOf(1),
        name: name("example"),
        draft: login("hunter2"),
        access: everyBot,
      });
    }).pipe(Effect.provide(Domain.layer));
    yield* onSecretsFile(
      (sql) => sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (3, 'from_later')`,
    );
    yield* Effect.gen(function* () {
      assert.strictEqual(yield* stateNow, "newer");
      assert.strictEqual(refusal(yield* Effect.exit((yield* Secrets).list)), "secrets-unavailable");
    }).pipe(Effect.provide(Domain.layer));
    // Still there for the release that wrote it.
    const records = yield* onSecretsFile((sql) => sql`SELECT id FROM records`);
    assert.strictEqual(records.length, 1);
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("keeps a connector's secret sealed, and out of the operator's list", () =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    assert.deepStrictEqual(yield* secrets.connectorSecrets.get(CONNECTOR), Option.none());
    yield* secrets.connectorSecrets.put(connectorSecret);
    const read = yield* secrets.connectorSecrets.get(CONNECTOR).pipe(Effect.map(Option.getOrThrow));
    const tokens = read.oauth?.tokens;
    assert.strictEqual(tokens && Redacted.value(tokens.accessToken), "access-token-value");
    assert.strictEqual(read.headers[0] && Redacted.value(read.headers[0].value), "header-value");

    const stored = yield* onSecretsFile((sql) => sql`SELECT sealed FROM record_fields`);
    assert.notInclude(JSON.stringify(stored), "token-value");
    assert.notInclude(JSON.stringify(stored), "address-key-value");
    assert.deepStrictEqual(yield* secrets.list, []);

    yield* secrets.connectorSecrets.remove(CONNECTOR);
    assert.deepStrictEqual(yield* secrets.connectorSecrets.get(CONNECTOR), Option.none());
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("tells references of a change only when what one resolves to may have changed", () =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    const ana = yield* createBot("Ana");
    const referencesNow = Effect.map(
      Stream.runHead(secrets.referenceStatus),
      (head) => Option.getOrThrow(head).revision,
    );
    const statusNow = Effect.map(
      Stream.runHead(secrets.status),
      (head) => Option.getOrThrow(head).revision,
    );
    const start = yield* referencesNow;
    yield* secrets.add({
      id: idOf(1),
      name: name("weather-api"),
      draft: value("weather-key-1"),
      access: everyBot,
    });
    const added = yield* referencesNow;
    assert.isAbove(added, start);

    // A reveal and a use are told to clients, never to references.
    const clientsBefore = yield* statusNow;
    yield* secrets.reveal({ id: idOf(1), field: "value", deviceId: DEVICE });
    yield* secrets.noteUse({
      names: [name("weather-api")],
      botId: ana.id,
      use: { _tag: "connector", name: Label.make("Weather") },
    });
    assert.isAbove(yield* statusNow, clientsBefore);
    assert.strictEqual(yield* referencesNow, added);

    yield* secrets.setAccess(idOf(1), onlyBots(ana.id));
    const shared = yield* referencesNow;
    assert.isAbove(shared, added);
    yield* secrets.update({ id: idOf(1), changes: { value: Redacted.make("weather-key-2") } });
    const updated = yield* referencesNow;
    assert.isAbove(updated, shared);
    yield* secrets.remove(idOf(1));
    assert.isAbove(yield* referencesNow, updated);
  }).pipe(Effect.provide(TestDomain.layer)),
);
