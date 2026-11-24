// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, it } from "@effect/vitest";
import {
  type CredentialDraft,
  CredentialId,
  DeviceId,
  Label,
  SiteOrigin,
} from "@j3-bots/contracts";
import { TestEngineControl } from "@j3-bots/engine-t3/testing";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Reactivity from "effect/reactivity/Reactivity";
import type * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import * as Domain from "../domain.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import * as TestDomain from "../testing/domain.ts";
import {
  awaitEntry,
  command,
  createBot,
  engineSession,
  nextTurn,
  sendToBot,
} from "../testing/turns.ts";
import { BotTools } from "../tools/BotTools.ts";
import { Cards } from "../turns/Cards.ts";
import { ConnectorId, type ConnectorSecret, connectorRecordId } from "./ConnectorSecret.ts";
import { NONCE_BYTES, sealField, unwrapDataKey, withDerivedKey } from "./crypto.ts";
import { VAULT_FILE, Vault } from "./Vault.ts";

const PASSWORD = Redacted.make("correct horse battery");
const WRONG = Redacted.make("incorrect horse battery");
const DEVICE = DeviceId.make("device-laptop");

const draft = (password: string): CredentialDraft => ({
  name: Label.make("Example"),
  origins: [SiteOrigin.make("https://example.com")],
  username: Redacted.make("ana@example.com"),
  password: Redacted.make(password),
  totp: Redacted.make("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"),
});

const idOf = (n: number) => CredentialId.make(`cred_${String(n).padStart(16, "0")}`);

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
};

/**
 * A test that derives the vault's key again and again, as a run of wrong
 * passwords does: each derivation is costly by design, and slower still
 * while the other test files keep the machine busy.
 */
const DERIVES_OFTEN = 20_000;

/** The vault's status now. */
const stateNow = Effect.gen(function* () {
  const vault = yield* Vault;
  return Option.getOrThrow(yield* Stream.runHead(vault.status));
});

/** The reason a refused request gives, or null when it was not refused. */
const refusal = <A, E>(exit: Exit.Exit<A, E>): string | null => {
  if (Exit.isSuccess(exit)) return null;
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error)) return "defect";
  const value: unknown = error.value;
  if (typeof value === "object" && value !== null && "reason" in value) {
    return String(value.reason);
  }
  return typeof value === "object" && value !== null && "_tag" in value
    ? String(value._tag)
    : "unknown";
};

/** Runs `use` on the vault's own database file, as something outside the server would. */
const onVaultFile = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const path = yield* Path.Path;
    const sql = yield* SqliteClient.make({
      filename: path.join(home, HOME_ENTRIES.vault, VAULT_FILE),
    });
    return yield* use(sql);
  }).pipe(Effect.scoped, Effect.provide(Reactivity.layer), Effect.orDie);

const KeyringRow = Schema.Struct({
  kdf_n: Schema.Int,
  kdf_r: Schema.Int,
  kdf_p: Schema.Int,
  salt: Schema.String,
  key_nonce: Schema.String,
  wrapped_key: Schema.String,
});

/** The vault's data key, as someone who knows `password` and has the file could unwrap it. */
const dataKeyOf = (password: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const [row] = yield* onVaultFile((sql) => sql`SELECT * FROM keyring`);
    const keyring = yield* Schema.decodeUnknownEffect(KeyringRow)(row).pipe(Effect.orDie);
    const params = { n: keyring.kdf_n, r: keyring.kdf_r, p: keyring.kdf_p };
    return yield* withDerivedKey(password, Buffer.from(keyring.salt, "base64"), params, (kek) =>
      Effect.sync(() =>
        Option.getOrThrow(
          unwrapDataKey(kek, {
            nonce: Buffer.from(keyring.key_nonce, "base64"),
            sealed: Buffer.from(keyring.wrapped_key, "base64"),
          }),
        ),
      ),
    );
  });

/** Seals `plain` as a record's field under `key`, in place of the value it had. */
const sealInto = (key: Uint8Array, recordId: string, field: string, plain: string) => {
  const sealed = sealField(
    key,
    recordId,
    field,
    Buffer.from(plain, "utf8"),
    crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
  );
  return onVaultFile(
    (sql) => sql`
      UPDATE record_fields
      SET nonce = ${Buffer.from(sealed.nonce).toString("base64")},
        sealed = ${Buffer.from(sealed.sealed).toString("base64")}
      WHERE record_id = ${recordId} AND field = ${field}
    `,
  );
};

it.effect("seals a login under the master password, and reads it back only unlocked", () =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    assert.strictEqual((yield* stateNow).state, "uninitialized");
    assert.strictEqual(refusal(yield* Effect.exit(vault.list)), "vault-not-set-up");

    yield* vault.setup(PASSWORD);
    assert.strictEqual((yield* stateNow).state, "unlocked");
    assert.strictEqual(refusal(yield* Effect.exit(vault.setup(PASSWORD))), "vault-set-up");

    const { credential } = yield* vault.save({
      id: idOf(1),
      draft: draft("hunter2"),
      allowedBots: [],
    });
    assert.deepStrictEqual(
      { name: credential.name, hasTotp: credential.hasTotp, allowed: credential.allowedBots },
      { name: "Example", hasTotp: true, allowed: [] },
    );
    const password = yield* vault.reveal({ id: idOf(1), field: "password", deviceId: DEVICE });
    assert.strictEqual(Redacted.value(password), "hunter2");
    const [listed] = yield* vault.list;
    assert.deepStrictEqual(listed?.lastReveal?.deviceId, DEVICE);
    assert.strictEqual(listed?.lastReveal?.field, "password");

    // Nothing in the file is the value.
    const stored = yield* onVaultFile((sql) => sql`SELECT sealed FROM record_fields`);
    assert.notInclude(JSON.stringify(stored), "hunter2");
    assert.notInclude(JSON.stringify(stored), "ana@example.com");

    yield* vault.lock;
    assert.strictEqual((yield* stateNow).state, "locked");
    assert.strictEqual(refusal(yield* Effect.exit(vault.list)), "vault-locked");
    assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(WRONG))), "master-password");
    yield* vault.unlock(PASSWORD);
    const again = yield* vault.reveal({ id: idOf(1), field: "username", deviceId: DEVICE });
    assert.strictEqual(Redacted.value(again), "ana@example.com");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("starts locked after every restart", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const vault = yield* Vault;
      yield* vault.setup(PASSWORD);
      yield* vault.save({ id: idOf(1), draft: draft("hunter2"), allowedBots: [] });
    }).pipe(Effect.provide(Domain.layer));
    yield* Effect.gen(function* () {
      const vault = yield* Vault;
      assert.strictEqual((yield* stateNow).state, "locked");
      assert.strictEqual(refusal(yield* Effect.exit(vault.list)), "vault-locked");
      yield* vault.unlock(PASSWORD);
      assert.strictEqual((yield* vault.list).length, 1);
    }).pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect(
  "changes the password by wrapping the same key again, leaving every value as sealed",
  () =>
    Effect.gen(function* () {
      const vault = yield* Vault;
      yield* vault.setup(PASSWORD);
      yield* vault.save({ id: idOf(1), draft: draft("hunter2"), allowedBots: [] });
      const sealedBefore = yield* onVaultFile((sql) => sql`SELECT * FROM record_fields`);
      const keyringBefore = yield* onVaultFile((sql) => sql`SELECT salt, wrapped_key FROM keyring`);

      const next = Redacted.make("a new and longer password");
      assert.strictEqual(
        refusal(yield* Effect.exit(vault.changePassword(WRONG, next))),
        "master-password",
      );
      yield* vault.changePassword(PASSWORD, next);

      assert.deepStrictEqual(
        yield* onVaultFile((sql) => sql`SELECT * FROM record_fields`),
        sealedBefore,
      );
      assert.notDeepEqual(
        yield* onVaultFile((sql) => sql`SELECT salt, wrapped_key FROM keyring`),
        keyringBefore,
      );
      yield* vault.lock;
      assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(PASSWORD))), "master-password");
      yield* vault.unlock(next);
      const password = yield* vault.reveal({ id: idOf(1), field: "password", deviceId: DEVICE });
      assert.strictEqual(Redacted.value(password), "hunter2");
    }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a sealed value moved to another login or field", () =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    yield* vault.setup(PASSWORD);
    yield* vault.save({ id: idOf(1), draft: draft("first secret"), allowedBots: [] });
    yield* vault.save({ id: idOf(2), draft: draft("second secret"), allowedBots: [] });

    // The second login's password, sealed for it, copied over the first's.
    yield* onVaultFile(
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
      vault.reveal({ id: idOf(1), field: "password", deviceId: DEVICE }),
    );
    assert.strictEqual(refusal(moved), "vault-damaged");

    // Within one login: its user name's seal in its password's place.
    yield* onVaultFile(
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
      vault.reveal({ id: idOf(2), field: "password", deviceId: DEVICE }),
    );
    assert.strictEqual(refusal(swapped), "vault-damaged");
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("refuses a value that opens but does not read back, and shows it nowhere", () => {
  const logged: Array<string> = [];
  const MARKER = "plain-value-marker";
  return Effect.gen(function* () {
    const vault = yield* Vault;
    yield* vault.setup(PASSWORD);
    yield* vault.save({ id: idOf(1), draft: draft("hunter2"), allowedBots: [] });
    yield* vault.connectorSecrets.put(connectorSecret);
    const key = yield* dataKeyOf(PASSWORD);
    const connector = connectorRecordId(CONNECTOR);
    // Sealed under the vault's own key, for the right record and field, in a shape it is not.
    yield* sealInto(key, idOf(1), "totp", JSON.stringify({ secret: MARKER }));
    yield* sealInto(key, connector, "oauth", JSON.stringify({ accessToken: MARKER }));

    const exits: Array<Exit.Exit<unknown, unknown>> = [
      yield* Effect.exit(vault.reveal({ id: idOf(1), field: "totp", deviceId: DEVICE })),
      yield* Effect.exit(vault.totpPreview(idOf(1))),
      yield* Effect.exit(vault.connectorSecrets.get(CONNECTOR)),
    ];
    // A name too long for one, which the list reads for every login.
    yield* sealInto(key, idOf(1), "name", `${"x".repeat(200)}${MARKER}`);
    exits.push(yield* Effect.exit(vault.list));

    for (const exit of exits) {
      assert.strictEqual(refusal(exit), "vault-damaged");
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

it.effect(
  "makes unlocking wait after repeated wrong passwords, even for the right one",
  () =>
    Effect.gen(function* () {
      const vault = yield* Vault;
      yield* vault.setup(PASSWORD);
      yield* vault.lock;
      for (let attempt = 0; attempt < 5; attempt++) {
        assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(WRONG))), "master-password");
      }
      assert.isNotNull((yield* stateNow).retryAt);
      assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(PASSWORD))), "RateLimited");

      yield* TestClock.adjust(Duration.seconds(30));
      yield* vault.unlock(PASSWORD);
      const status = yield* stateNow;
      assert.deepStrictEqual([status.state, status.retryAt], ["unlocked", null]);
    }).pipe(Effect.provide(TestDomain.layer)),
  DERIVES_OFTEN,
);

it.effect(
  "keeps counting wrong passwords, and waiting, across a restart",
  () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const vault = yield* Vault;
        yield* vault.setup(PASSWORD);
        yield* vault.lock;
        for (let attempt = 0; attempt < 5; attempt++) {
          assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(WRONG))), "master-password");
        }
      }).pipe(Effect.provide(Domain.layer));
      yield* Effect.gen(function* () {
        const vault = yield* Vault;
        assert.isNotNull((yield* stateNow).retryAt);
        assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(PASSWORD))), "RateLimited");
        yield* TestClock.adjust(Duration.seconds(30));
        // The sixth in a row, counted from before the restart: twice the first wait.
        assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(WRONG))), "master-password");
        yield* TestClock.adjust(Duration.seconds(59));
        assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(PASSWORD))), "RateLimited");
        yield* TestClock.adjust(Duration.seconds(1));
        yield* vault.unlock(PASSWORD);
      }).pipe(Effect.provide(Domain.layer));
      // A right one forgets them, across a restart too.
      yield* Effect.gen(function* () {
        const vault = yield* Vault;
        assert.isNull((yield* stateNow).retryAt);
        assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(WRONG))), "master-password");
        yield* vault.unlock(PASSWORD);
      }).pipe(Effect.provide(Domain.layer));
    }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
  DERIVES_OFTEN,
);

it.effect(
  "starts counting wrong passwords over after a day without one",
  () =>
    Effect.gen(function* () {
      const vault = yield* Vault;
      yield* vault.setup(PASSWORD);
      yield* vault.lock;
      for (let attempt = 0; attempt < 4; attempt++) {
        assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(WRONG))), "master-password");
      }
      yield* TestClock.adjust(Duration.hours(24));
      assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(WRONG))), "master-password");
      assert.isNull((yield* stateNow).retryAt);
      yield* vault.unlock(PASSWORD);
    }).pipe(Effect.provide(TestDomain.layer)),
  DERIVES_OFTEN,
);

it.effect("refuses key settings out of range without trying them or counting a failure", () =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    yield* vault.setup(PASSWORD);
    yield* vault.lock;
    yield* onVaultFile((sql) => sql`UPDATE keyring SET kdf_n = ${2 ** 24}`);
    for (let attempt = 0; attempt < 6; attempt++) {
      assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(PASSWORD))), "vault-damaged");
    }
    assert.isNull((yield* stateNow).retryAt);
    assert.deepStrictEqual(yield* onVaultFile((sql) => sql`SELECT * FROM unlock_failures`), []);
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("leaves a vault a newer release changed as it was, and refuses to use it", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const vault = yield* Vault;
      yield* vault.setup(PASSWORD);
    }).pipe(Effect.provide(Domain.layer));
    yield* onVaultFile(
      (sql) => sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (2, 'from_later')`,
    );
    yield* Effect.gen(function* () {
      const vault = yield* Vault;
      assert.strictEqual((yield* stateNow).state, "newer");
      assert.strictEqual(refusal(yield* Effect.exit(vault.unlock(PASSWORD))), "vault-newer");
    }).pipe(Effect.provide(Domain.layer));
    // Still there for the release that wrote it.
    const keyring = yield* onVaultFile((sql) => sql`SELECT id FROM keyring`);
    assert.strictEqual(keyring.length, 1);
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine))),
);

it.effect("keeps a connector's secret sealed with the logins, and locked with them", () =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    const connectorId = CONNECTOR;
    const secret = connectorSecret;
    yield* vault.setup(PASSWORD);
    assert.deepStrictEqual(yield* vault.connectorSecrets.get(connectorId), Option.none());
    yield* vault.connectorSecrets.put(secret);
    const read = yield* vault.connectorSecrets.get(connectorId).pipe(Effect.map(Option.getOrThrow));
    const tokens = read.oauth?.tokens;
    assert.strictEqual(tokens && Redacted.value(tokens.accessToken), "access-token-value");
    assert.strictEqual(read.headers[0] && Redacted.value(read.headers[0].value), "header-value");
    assert.strictEqual(
      read.address && Redacted.value(read.address),
      "https://mcp.example/mcp?key=address-key-value",
    );

    const stored = yield* onVaultFile((sql) => sql`SELECT sealed FROM record_fields`);
    assert.notInclude(JSON.stringify(stored), "token-value");
    assert.notInclude(JSON.stringify(stored), "address-key-value");
    // Not a login: the list has none.
    assert.deepStrictEqual(yield* vault.list, []);

    yield* vault.lock;
    assert.strictEqual(
      refusal(yield* Effect.exit(vault.connectorSecrets.get(connectorId))),
      "vault-locked",
    );
    yield* vault.unlock(PASSWORD);
    yield* vault.connectorSecrets.remove(connectorId);
    assert.deepStrictEqual(yield* vault.connectorSecrets.get(connectorId), Option.none());
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("saves a login a bot asked for from its card, which then shows it saved", () =>
  Effect.gen(function* () {
    const control = yield* TestEngineControl;
    const tools = yield* BotTools;
    const cards = yield* Cards;
    const vault = yield* Vault;
    const bot = yield* createBot("Ana");
    const session = yield* engineSession(bot.id);
    yield* sendToBot(bot.id, "Read this month's reports.");
    const turnId = yield* nextTurn(bot.id);
    const input = { origin: "https://example.com/login?next=/", note: "To read the reports." };

    yield* control.toolCall({
      sessionId: session,
      turnId,
      tool: "request_credential",
      input,
      recorded: "now",
    });
    const reply = yield* tools.call({
      requestId: "call-1",
      sessionId: session,
      tool: "request_credential",
      arguments: input,
    });
    assert.strictEqual(reply._tag, "result");
    const card = yield* awaitEntry(bot.id, "credential-request");
    assert.deepStrictEqual(
      [card.origin, card.note, card.status],
      ["https://example.com", "To read the reports.", { _tag: "pending" }],
    );

    // Locked or never set up, the card stays open.
    const before = yield* Effect.exit(
      cards.saveCredential({
        id: idOf(1),
        draft: draft("hunter2"),
        allowedBots: [],
        request: card.id,
      }),
    );
    assert.strictEqual(refusal(before), "vault-not-set-up");
    yield* vault.setup(PASSWORD);
    const saved = yield* cards.saveCredential({
      id: idOf(1),
      draft: draft("hunter2"),
      allowedBots: [bot.id],
      request: card.id,
    });
    assert.deepStrictEqual(saved.allowedBots, [bot.id]);
    const closed = yield* awaitEntry(bot.id, "credential-request");
    assert.deepStrictEqual(closed.status, {
      _tag: "saved",
      credentialId: idOf(1),
      name: "Example",
    });

    // Saving again, as after a lost reply, adds nothing.
    yield* cards.saveCredential({
      id: idOf(1),
      draft: draft("hunter2"),
      allowedBots: [],
      request: card.id,
    });
    assert.strictEqual((yield* vault.list).length, 1);
    // A saved card takes no dismissal.
    const dismissed = yield* Effect.exit(
      cards.answer({ commandId: command(), entryId: card.id, answer: { _tag: "dismiss" } }),
    );
    assert.strictEqual(refusal(dismissed), "card-closed");
  }).pipe(Effect.provide(TestDomain.layer)),
);
