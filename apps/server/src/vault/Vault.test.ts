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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
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
import { ConnectorId, type ConnectorSecret } from "./ConnectorSecret.ts";
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

it.effect("changes the password by wrapping the same key again, leaving every value as sealed", () =>
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
    assert.isTrue(Exit.hasDies(moved));

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
    assert.isTrue(Exit.hasDies(swapped));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("makes unlocking wait after repeated wrong passwords, even for the right one", () =>
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
    const connectorId = ConnectorId.make("notion");
    const secret: ConnectorSecret = {
      connectorId,
      oauth: {
        client: { issuer: "https://auth.example", clientId: "client-1", clientSecret: null },
        tokens: {
          accessToken: Redacted.make("access-token-value"),
          refreshToken: Redacted.make("refresh-token-value"),
          expiresAt: null,
          scopes: ["read"],
          resource: "https://mcp.example/mcp",
        },
      },
      headers: [{ name: "X-Api-Key", value: Redacted.make("header-value") }],
      env: [],
    };
    yield* vault.setup(PASSWORD);
    assert.deepStrictEqual(yield* vault.connectorSecrets.get(connectorId), Option.none());
    yield* vault.connectorSecrets.put(secret);
    const read = yield* vault.connectorSecrets.get(connectorId).pipe(Effect.map(Option.getOrThrow));
    const tokens = read.oauth?.tokens;
    assert.strictEqual(tokens && Redacted.value(tokens.accessToken), "access-token-value");
    assert.strictEqual(read.headers[0] && Redacted.value(read.headers[0].value), "header-value");

    const stored = yield* onVaultFile((sql) => sql`SELECT sealed FROM record_fields`);
    assert.notInclude(JSON.stringify(stored), "token-value");
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
      cards.saveCredential({ id: idOf(1), draft: draft("hunter2"), allowedBots: [], request: card.id }),
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
    assert.deepStrictEqual(closed.status, { _tag: "saved", credentialId: idOf(1), name: "Example" });

    // Saving again, as after a lost reply, adds nothing.
    yield* cards.saveCredential({ id: idOf(1), draft: draft("hunter2"), allowedBots: [], request: card.id });
    assert.strictEqual((yield* vault.list).length, 1);
    // A saved card takes no dismissal.
    const dismissed = yield* Effect.exit(
      cards.answer({ commandId: command(), entryId: card.id, answer: { _tag: "dismiss" } }),
    );
    assert.strictEqual(refusal(dismissed), "card-closed");
  }).pipe(Effect.provide(TestDomain.layer)),
);
