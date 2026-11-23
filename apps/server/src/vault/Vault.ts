// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import {
  BotId,
  Conflict,
  type Credential,
  type CredentialDraft,
  CredentialField,
  CredentialId,
  CredentialOrigins,
  DeviceId,
  Invalid,
  Label,
  NotFound,
  RateLimited,
  type TotpPreview,
  type VaultState,
  type VaultStatus,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { BotStore } from "../bots/BotStore.ts";
import { ServerConfig } from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import { Layout } from "../Layout.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { migrate } from "../persistence/Migrations.ts";
import { transactional } from "../persistence/transaction.ts";
import {
  KDF_PARAMS,
  type KdfParams,
  KEY_BYTES,
  kdfParamsInRange,
  NONCE_BYTES,
  openField,
  SALT_BYTES,
  type Sealed,
  sealField,
  unwrapDataKey,
  withDerivedKey,
  wrapDataKey,
} from "./crypto.ts";
import {
  type ConnectorId,
  ConnectorSecret,
  connectorRecordId,
  NamedSecret,
} from "./ConnectorSecret.ts";
import Migration0001 from "./migrations/0001_initial.ts";
import { parseTotpSetup, TotpConfig, totpAt } from "./totp.ts";

/**
 * The scrypt parameters a new keyring gets: `KDF_PARAMS`. A test that derives
 * many keys gives cheaper ones the vault still accepts; a keyring already
 * written keeps the parameters it records.
 */
export class VaultKdf extends Context.Reference<KdfParams>("@j3-bots/server/vault/Vault/VaultKdf", {
  defaultValue: () => KDF_PARAMS,
}) {}

/** The vault's file, inside its own folder of the home. */
export const VAULT_FILE = "vault.sqlite";

/** The vault's migrations, forward only, like the database's (`persistence/Migrations.ts`). */
const migrations = SqliteMigrator.fromRecord({ "1_initial": Migration0001 });

/** Wrong passwords in a row before unlocking waits. */
const FREE_ATTEMPTS = 5;
/** The first wait, doubled by each wrong password after it, up to `MAX_WAIT`. */
const FIRST_WAIT = Duration.seconds(30);
const MAX_WAIT = Duration.hours(1);
/** A day with no wrong password starts the count over. */
const FAILURES_FORGOTTEN_AFTER = Duration.hours(24);

/** How long unlocking waits after `failures` wrong passwords in a row; none before `FREE_ATTEMPTS`. */
const unlockWait = (failures: number): Option.Option<Duration.Duration> =>
  failures < FREE_ATTEMPTS
    ? Option.none()
    : Option.some(
        Duration.min(
          Duration.times(FIRST_WAIT, 2 ** Math.min(failures - FREE_ATTEMPTS, 16)),
          MAX_WAIT,
        ),
      );

const KeyringRow = Schema.Struct({
  kdf_n: Schema.Int,
  kdf_r: Schema.Int,
  kdf_p: Schema.Int,
  salt: Schema.String,
  key_nonce: Schema.String,
  wrapped_key: Schema.String,
});
type KeyringRow = typeof KeyringRow.Type;

const UnlockFailuresRow = Schema.Struct({
  failures: Schema.Int,
  last_at: Time,
  retry_at: Schema.NullOr(Time),
});

const RecordRow = Schema.Struct({
  id: CredentialId,
  created_at: Time,
  updated_at: Time,
});

const FieldRow = Schema.Struct({
  record_id: Schema.String,
  field: Schema.String,
  nonce: Schema.String,
  sealed: Schema.String,
});
type FieldRow = typeof FieldRow.Type;

const BotRow = Schema.Struct({ record_id: Schema.String, bot_id: BotId });

const RevealRow = Schema.Struct({
  record_id: Schema.String,
  field: CredentialField,
  device_id: DeviceId,
  at: Time,
});

/** The fields a login seals, by name. `totp` only when it has a code generator. */
type CredentialSealedField = "name" | "origins" | "username" | "password" | "totp";

const OriginsJson = json(CredentialOrigins);
const TotpJson = json(TotpConfig);
const ConnectorOAuthJson = json(ConnectorSecret.fields.oauth);
const NamedSecretsJson = json(Schema.Array(NamedSecret));

/** The fields a connector's record seals, one value each. */
const CONNECTOR_FIELDS = ["oauth", "headers", "env"] as const;

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytesOf = (text: string) => Buffer.from(text, "base64");
const utf8 = (text: string) => Buffer.from(text, "utf8");

/**
 * A value the caller gave that does not encode for the vault. Its types rule
 * that out; should it happen, the defect says so without the value, which the
 * encoder's own error could carry.
 */
const unencodable = (what: string) => Effect.die(new Error(`The vault could not encode ${what}.`));

/**
 * The vault (`docs/architecture/server.md`, "The vault"): saved logins sealed
 * under a key that only the master password gives, which the server holds in
 * memory from an unlock until a lock or its stop. It starts locked. Every
 * value comes and goes as a redacted type, and nothing here logs one or puts
 * one in an error.
 */
export class Vault extends Context.Service<
  Vault,
  {
    /** The status now, then each change. */
    readonly status: Stream.Stream<VaultStatus>;
    readonly setup: (password: Redacted.Redacted<string>) => Effect.Effect<void, Conflict>;
    readonly unlock: (
      password: Redacted.Redacted<string>,
    ) => Effect.Effect<void, Conflict | Invalid | RateLimited>;
    readonly lock: Effect.Effect<void>;
    readonly changePassword: (
      current: Redacted.Redacted<string>,
      next: Redacted.Redacted<string>,
    ) => Effect.Effect<void, Conflict | Invalid | RateLimited>;
    readonly list: Effect.Effect<ReadonlyArray<Credential>, Conflict>;
    /** One value, recording when it was shown and on which device. */
    readonly reveal: (input: {
      readonly id: CredentialId;
      readonly field: CredentialField;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<Redacted.Redacted<string>, Conflict | NotFound>;
    /**
     * Saves a new login as `id`. When `id` is saved already, nothing changes
     * and `created` is false.
     */
    readonly save: (input: {
      readonly id: CredentialId;
      readonly draft: CredentialDraft;
      readonly allowedBots: ReadonlyArray<BotId>;
    }) => Effect.Effect<
      { readonly credential: Credential; readonly created: boolean },
      Conflict | Invalid | NotFound
    >;
    readonly update: (input: {
      readonly id: CredentialId;
      readonly changes: Partial<CredentialDraft>;
    }) => Effect.Effect<Credential, Conflict | Invalid | NotFound>;
    readonly remove: (id: CredentialId) => Effect.Effect<void, Conflict>;
    readonly setAllowedBots: (
      id: CredentialId,
      bots: ReadonlyArray<BotId>,
    ) => Effect.Effect<Credential, Conflict | NotFound>;
    readonly totpPreview: (id: CredentialId) => Effect.Effect<TotpPreview, Conflict | NotFound>;
    /**
     * A login's value for the server to type into a bot's browser tab
     * (`Fill.ts`): its user name, its password, or its one-time code now,
     * with the login as it was when the value was opened, read together so
     * no change to the login falls between them. Fails with
     * `NotFound("credential")` for a login without that value, an empty user
     * name included. Nothing records it as shown: no device saw it.
     */
    readonly fillValue: (input: {
      readonly id: CredentialId;
      readonly field: CredentialField;
    }) => Effect.Effect<
      { readonly value: Redacted.Redacted<string>; readonly credential: Credential },
      Conflict | NotFound
    >;
    /**
     * What connectors need to reach their servers: OAuth clients and tokens,
     * headers and environment values. The master password locks them with
     * the logins, so while the vault is locked every one fails with
     * `Conflict("vault-locked")`, which a connector reports as its own state:
     * it makes no call until a client unlocks the vault. The status stream
     * says when that happens. None of these changes `revision`, which counts
     * the logins a client lists.
     */
    readonly connectorSecrets: {
      /** The connector's secret; none when it has no secret saved. */
      readonly get: (id: ConnectorId) => Effect.Effect<Option.Option<ConnectorSecret>, Conflict>;
      /** Saves the connector's secret whole, replacing the one it had. */
      readonly put: (secret: ConnectorSecret) => Effect.Effect<void, Conflict>;
      /** Deletes it. Deleting one already gone succeeds. */
      readonly remove: (id: ConnectorId) => Effect.Effect<void, Conflict>;
    };
  }
>()("@j3-bots/server/vault/Vault") {}

/** The vault's database, open and migrated, or left alone because a newer release wrote it. */
type VaultFile =
  | { readonly _tag: "open"; readonly sql: SqlClient.SqlClient }
  | { readonly _tag: "newer" };

/**
 * Opens the vault's database at `location`, migrated. One that records a
 * migration this release does not know is left as it is: the release that
 * wrote it can still read it, so it is refused here without stopping the
 * server.
 */
const openVaultFile = Effect.fn("Vault.open")(function* (location: string) {
  const sql = yield* SqliteClient.make({ filename: location });
  const provided = Effect.provideService(SqlClient.SqlClient, sql);
  yield* sql`PRAGMA foreign_keys = ON`;
  const [table] = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (table !== undefined) {
    const known = new Set((yield* migrations).map(([id]) => id));
    const recorded = yield* sql<{ readonly migration_id: number }>`
      SELECT migration_id FROM effect_sql_migrations
    `;
    if (recorded.some(({ migration_id }) => !known.has(migration_id))) {
      yield* Effect.logWarning(
        "A newer release of J3 Bots changed the vault, which this one cannot read; it stays as it is",
      );
      return { _tag: "newer" } as const satisfies VaultFile;
    }
  }
  yield* provided(migrate(migrations));
  return { _tag: "open", sql } as const satisfies VaultFile;
});

export const layer = Layer.effect(
  Vault,
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = yield* Layout;
    const bots = yield* BotStore;
    const random = yield* SecureRandom.SecureRandom;
    const kdf = yield* VaultKdf;

    const folder = yield* layout.writable(path.join(home, HOME_ENTRIES.vault)).pipe(Effect.orDie);
    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
    const file: VaultFile = yield* openVaultFile(path.join(folder, VAULT_FILE)).pipe(
      Effect.provide(Reactivity.layer),
      Effect.orDie,
    );

    /** The data key while unlocked; zeroed and dropped on lock. */
    let dataKey: Buffer | null = null;
    let revision = 0;

    const keyringOf = (sql: SqlClient.SqlClient) =>
      SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: KeyringRow,
        execute: () => sql`
          SELECT kdf_n, kdf_r, kdf_p, salt, key_nonce, wrapped_key FROM keyring WHERE id = 1
        `,
      })(undefined).pipe(Effect.orDie);

    /**
     * Wrong passwords in a row, the last one's time, and until when unlocking
     * is refused. The file keeps them, so a restart neither resets the count
     * nor ends a wait; this is its copy.
     */
    const failuresOf = (sql: SqlClient.SqlClient) =>
      SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: UnlockFailuresRow,
        execute: () => sql`SELECT failures, last_at, retry_at FROM unlock_failures WHERE id = 1`,
      })(undefined).pipe(Effect.orDie);
    const stored = file._tag === "open" ? yield* failuresOf(file.sql) : Option.none();
    let failures = Option.match(stored, { onNone: () => 0, onSome: (row) => row.failures });
    let lastFailureAt = Option.match(stored, {
      onNone: () => null,
      onSome: (row) => row.last_at,
    });
    let retryAt = Option.match(stored, { onNone: () => null, onSome: (row) => row.retry_at });

    const initialState: VaultState =
      file._tag === "newer"
        ? "newer"
        : Option.isSome(yield* keyringOf(file.sql))
          ? "locked"
          : "uninitialized";
    const state = yield* SubscriptionRef.make<VaultStatus>({
      state: initialState,
      revision,
      retryAt:
        retryAt !== null && DateTime.isGreaterThan(retryAt, yield* DateTime.now) ? retryAt : null,
    });

    const publish = (next: VaultState) =>
      SubscriptionRef.set(state, { state: next, revision, retryAt });

    /** One request at a time: none reads the key while another replaces or zeroes it. */
    const exclusive = Semaphore.makeUnsafe(1);
    const serial = <A, E, R>(effect: Effect.Effect<A, E, R>) => exclusive.withPermit(effect);

    const forgetKey = () => {
      if (dataKey !== null) dataKey.fill(0);
      dataKey = null;
    };
    yield* Effect.addFinalizer(() => Effect.sync(forgetKey));

    const randomBuffer = (size: number) =>
      Effect.map(random.randomBytes(size), (bytes) => {
        const copy = Buffer.alloc(size);
        copy.set(bytes);
        bytes.fill(0);
        return copy;
      });

    /** The open database, or the conflict the vault's state is. */
    const database = Effect.gen(function* () {
      if (file._tag === "newer") return yield* new Conflict({ reason: "vault-newer" });
      return file.sql;
    });

    /** The open database and the data key, or the conflict the vault's state is. */
    const unlocked = Effect.gen(function* () {
      const sql = yield* database;
      if (dataKey !== null) return { sql, key: dataKey };
      const current = (yield* SubscriptionRef.get(state)).state;
      return yield* new Conflict({
        reason: current === "uninitialized" ? "vault-not-set-up" : "vault-locked",
      });
    });

    /**
     * A value of the vault that does not open under its key or read back as
     * what it should be. The log names the record and field, never the value,
     * and the caller gets a refusal it can show.
     */
    const damaged = (recordId: string, field: string) =>
      Effect.logError("A value in the vault does not open or read back: its file was changed").pipe(
        Effect.annotateLogs({ recordId, field }),
        Effect.andThen(Effect.fail(new Conflict({ reason: "vault-damaged" }))),
      );

    /** `decoded`, a value read back from the vault, or `damaged` without the decoder's error. */
    const readBack = <A, R>(
      recordId: string,
      field: string,
      decoded: Effect.Effect<A, Schema.SchemaError, R>,
    ) => decoded.pipe(Effect.catchTag("SchemaError", () => damaged(recordId, field)));

    /** Counts a wrong password, in the file too, and publishes the wait it brings. */
    const countFailure = Effect.fn("Vault.countFailure")(function* (
      sql: SqlClient.SqlClient,
      now: DateTime.Utc,
    ) {
      const forgotten =
        lastFailureAt !== null &&
        DateTime.isGreaterThanOrEqualTo(
          now,
          DateTime.addDuration(lastFailureAt, FAILURES_FORGOTTEN_AFTER),
        );
      failures = (forgotten ? 0 : failures) + 1;
      lastFailureAt = now;
      const wait = unlockWait(failures);
      retryAt = Option.isSome(wait) ? DateTime.addDuration(now, wait.value) : null;
      yield* sql`
        INSERT INTO unlock_failures (id, failures, last_at, retry_at)
        VALUES (1, ${failures}, ${timeText(now)}, ${retryAt === null ? null : timeText(retryAt)})
        ON CONFLICT (id) DO UPDATE SET
          failures = excluded.failures, last_at = excluded.last_at, retry_at = excluded.retry_at
      `.pipe(Effect.orDie);
      yield* Effect.logWarning("A wrong vault password was given").pipe(
        Effect.annotateLogs({ failures }),
      );
      yield* publish((yield* SubscriptionRef.get(state)).state);
    });

    /** Forgets the wrong passwords counted, after a right one. */
    const clearFailures = Effect.fn("Vault.clearFailures")(function* (sql: SqlClient.SqlClient) {
      if (failures === 0 && lastFailureAt === null) return;
      failures = 0;
      lastFailureAt = null;
      retryAt = null;
      yield* sql`DELETE FROM unlock_failures WHERE id = 1`.pipe(Effect.orDie);
    });

    /**
     * The data key `password` unwraps, or a refusal: while unlocking waits,
     * before checking; for a wrong password, which is counted; for key
     * settings out of range, which are not tried and not counted.
     */
    const checkPassword = Effect.fn("Vault.checkPassword")(function* (
      sql: SqlClient.SqlClient,
      password: Redacted.Redacted<string>,
      keyring: KeyringRow,
    ) {
      const now = yield* DateTime.now;
      if (retryAt !== null && DateTime.isLessThan(now, retryAt)) {
        return yield* new RateLimited({ retryAt });
      }
      const params: KdfParams = { n: keyring.kdf_n, r: keyring.kdf_r, p: keyring.kdf_p };
      if (!kdfParamsInRange(params)) {
        yield* Effect.logError(
          "The vault's key settings are out of range: its file was changed",
        ).pipe(Effect.annotateLogs({ n: params.n, r: params.r, p: params.p }));
        return yield* new Conflict({ reason: "vault-damaged" });
      }
      const key = yield* withDerivedKey(password, bytesOf(keyring.salt), params, (kek) =>
        Effect.succeed(
          unwrapDataKey(kek, {
            nonce: bytesOf(keyring.key_nonce),
            sealed: bytesOf(keyring.wrapped_key),
          }),
        ),
      );
      if (Option.isNone(key)) {
        yield* countFailure(sql, now);
        return yield* new Invalid({ reason: "master-password" });
      }
      yield* clearFailures(sql);
      return key.value;
    });

    const keyringOrConflict = Effect.gen(function* () {
      const sql = yield* database;
      const keyring = yield* keyringOf(sql);
      if (Option.isNone(keyring)) return yield* new Conflict({ reason: "vault-not-set-up" });
      return { sql, keyring: keyring.value };
    });

    /** A keyring row for `password` around `key`, with a fresh salt. */
    const keyringFor = Effect.fn("Vault.keyringFor")(function* (
      password: Redacted.Redacted<string>,
      key: Uint8Array,
    ) {
      const salt = yield* randomBuffer(SALT_BYTES);
      const nonce = yield* randomBuffer(NONCE_BYTES);
      const wrapped = yield* withDerivedKey(password, salt, kdf, (kek) =>
        Effect.sync(() => wrapDataKey(kek, key, nonce)),
      );
      return {
        salt: base64(salt),
        key_nonce: base64(wrapped.nonce),
        wrapped_key: base64(wrapped.sealed),
      };
    });

    const setup = (password: Redacted.Redacted<string>) =>
      serial(
        Effect.gen(function* () {
          const sql = yield* database;
          if (Option.isSome(yield* keyringOf(sql))) {
            return yield* new Conflict({ reason: "vault-set-up" });
          }
          const key = yield* randomBuffer(KEY_BYTES);
          const row = yield* keyringFor(password, key);
          const now = timeText(yield* DateTime.now);
          yield* sql`
            INSERT INTO keyring (
              id, kdf, kdf_n, kdf_r, kdf_p, salt, key_nonce, wrapped_key, created_at, changed_at
            ) VALUES (
              1, 'scrypt', ${kdf.n}, ${kdf.r}, ${kdf.p}, ${row.salt},
              ${row.key_nonce}, ${row.wrapped_key}, ${now}, ${now}
            )
          `.pipe(Effect.orDie);
          forgetKey();
          dataKey = key;
          yield* Effect.logInfo("The vault was set up");
          yield* publish("unlocked");
        }),
      );

    const unlock = (password: Redacted.Redacted<string>) =>
      serial(
        Effect.gen(function* () {
          const { sql, keyring } = yield* keyringOrConflict;
          const key = yield* checkPassword(sql, password, keyring);
          forgetKey();
          dataKey = key;
          yield* Effect.logInfo("The vault was unlocked");
          yield* publish("unlocked");
        }),
      );

    const lock = serial(
      Effect.gen(function* () {
        const current = (yield* SubscriptionRef.get(state)).state;
        if (current !== "unlocked") return;
        forgetKey();
        yield* Effect.logInfo("The vault was locked");
        yield* publish("locked");
      }),
    );

    const changePassword = (current: Redacted.Redacted<string>, next: Redacted.Redacted<string>) =>
      serial(
        Effect.gen(function* () {
          const { sql, keyring } = yield* keyringOrConflict;
          const key = yield* checkPassword(sql, current, keyring);
          const row = yield* keyringFor(next, key);
          yield* sql`
            UPDATE keyring SET kdf_n = ${kdf.n}, kdf_r = ${kdf.r},
              kdf_p = ${kdf.p}, salt = ${row.salt}, key_nonce = ${row.key_nonce},
              wrapped_key = ${row.wrapped_key}, changed_at = ${timeText(yield* DateTime.now)}
            WHERE id = 1
          `.pipe(Effect.orDie);
          // Checking the password unlocks, as `vault.unlock` would.
          forgetKey();
          dataKey = key;
          yield* Effect.logInfo("The vault's password was changed");
          yield* publish("unlocked");
        }),
      );

    // ---- Records ------------------------------------------------------------------

    const sealedRow = <Field extends string>(
      key: Uint8Array,
      id: string,
      field: Field,
      plain: Uint8Array,
    ) =>
      Effect.map(randomBuffer(NONCE_BYTES), (nonce) => {
        const value = sealField(key, id, field, plain, nonce);
        return { field, nonce: base64(value.nonce), sealed: base64(value.sealed) };
      });

    const openRow = (key: Uint8Array, row: FieldRow): Effect.Effect<Buffer, Conflict> => {
      const value: Sealed = { nonce: bytesOf(row.nonce), sealed: bytesOf(row.sealed) };
      return Option.match(openField(key, row.record_id, row.field, value), {
        onNone: () => damaged(row.record_id, row.field),
        onSome: Effect.succeed,
      });
    };

    const fieldsOf = (
      sql: SqlClient.SqlClient,
      ids: ReadonlyArray<string>,
      fields: ReadonlyArray<string>,
    ) =>
      ids.length === 0
        ? Effect.succeed<ReadonlyArray<FieldRow>>([])
        : SqlSchema.findAll({
            Request: Schema.Void,
            Result: FieldRow,
            execute: () => sql`
              SELECT record_id, field, nonce, sealed FROM record_fields
              WHERE ${sql.in("record_id", ids)} AND ${sql.in("field", fields)}
            `,
          })(undefined).pipe(Effect.orDie);

    const text = (bytes: Buffer) => {
      const value = bytes.toString("utf8");
      bytes.fill(0);
      return value;
    };

    /** The bots that still exist, of `ids`. */
    const existingBots = Effect.fn("Vault.existingBots")(function* (ids: ReadonlyArray<BotId>) {
      const known = new Set<string>((yield* bots.list).map(({ bot }) => bot.id));
      return ids.filter((id) => known.has(id));
    });

    /** Every login, or the ones of `only`, without their values. */
    const readCredentials = Effect.fn("Vault.readCredentials")(function* (
      sql: SqlClient.SqlClient,
      key: Uint8Array,
      only: Option.Option<string>,
    ) {
      const records = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: RecordRow,
        execute: () =>
          Option.match(only, {
            onNone: () => sql`
              SELECT id, created_at, updated_at FROM records WHERE kind = 'credential'
              ORDER BY created_at, id
            `,
            onSome: (id) => sql`
              SELECT id, created_at, updated_at FROM records
              WHERE kind = 'credential' AND id = ${id}
            `,
          }),
      })(undefined).pipe(Effect.orDie);
      const ids = records.map(({ id }) => id);
      const fields = yield* fieldsOf(sql, ids, ["name", "origins", "totp"]);
      const allowed =
        ids.length === 0
          ? []
          : yield* SqlSchema.findAll({
              Request: Schema.Void,
              Result: BotRow,
              execute: () => sql`
                SELECT record_id, bot_id FROM record_bots WHERE ${sql.in("record_id", ids)}
                ORDER BY bot_id
              `,
            })(undefined).pipe(Effect.orDie);
      const reveals =
        ids.length === 0
          ? []
          : yield* SqlSchema.findAll({
              Request: Schema.Void,
              Result: RevealRow,
              execute: () => sql`
                SELECT r.record_id, r.field, r.device_id, r.at FROM reveals r
                WHERE ${sql.in("r.record_id", ids)}
                  AND r.seq = (SELECT MAX(seq) FROM reveals l WHERE l.record_id = r.record_id)
              `,
            })(undefined).pipe(Effect.orDie);
      const known = new Set<string>(yield* existingBots(allowed.map(({ bot_id }) => bot_id)));
      const credentials: Array<Credential> = [];
      for (const record of records) {
        const own = fields.filter((row) => row.record_id === record.id);
        const nameRow = own.find((row) => row.field === "name");
        const originsRow = own.find((row) => row.field === "origins");
        if (nameRow === undefined) return yield* damaged(record.id, "name");
        if (originsRow === undefined) return yield* damaged(record.id, "origins");
        const name = yield* readBack(
          record.id,
          "name",
          Schema.decodeEffect(Label)(text(yield* openRow(key, nameRow))),
        );
        const origins = yield* readBack(
          record.id,
          "origins",
          Schema.decodeEffect(OriginsJson)(text(yield* openRow(key, originsRow))),
        );
        const reveal = reveals.find((row) => row.record_id === record.id);
        credentials.push({
          id: record.id,
          name,
          origins,
          hasTotp: own.some((row) => row.field === "totp"),
          allowedBots: allowed.flatMap((row) =>
            row.record_id === record.id && known.has(row.bot_id) ? [row.bot_id] : [],
          ),
          createdAt: record.created_at,
          updatedAt: record.updated_at,
          lastReveal:
            reveal === undefined
              ? null
              : { at: reveal.at, deviceId: reveal.device_id, field: reveal.field },
        });
      }
      return credentials;
    });

    const credentialOf = (sql: SqlClient.SqlClient, key: Uint8Array, id: CredentialId) =>
      Effect.flatMap(readCredentials(sql, key, Option.some(id)), ([credential]) =>
        credential === undefined
          ? Effect.fail(new NotFound({ resource: "credential" }))
          : Effect.succeed(credential),
      );

    const list = serial(
      Effect.gen(function* () {
        const { sql, key } = yield* unlocked;
        return yield* readCredentials(sql, key, Option.none());
      }),
    );

    /** The bots of `ids`, each once, refusing one that does not exist. */
    const allowedOf = Effect.fn("Vault.allowedOf")(function* (ids: ReadonlyArray<BotId>) {
      const unique = [...new Set(ids)];
      if ((yield* existingBots(unique)).length !== unique.length) {
        return yield* new NotFound({ resource: "bot" });
      }
      return unique;
    });

    /** The sealed rows for a draft's fields that are given; `totp: null` gives none. */
    const sealedDraft = Effect.fn("Vault.sealedDraft")(function* (
      key: Uint8Array,
      id: string,
      draft: Partial<CredentialDraft>,
    ) {
      const rows: Array<{ field: CredentialSealedField; nonce: string; sealed: string }> = [];
      if (draft.name !== undefined) rows.push(yield* sealedRow(key, id, "name", utf8(draft.name)));
      if (draft.origins !== undefined) {
        const origins = yield* Schema.encodeEffect(OriginsJson)(draft.origins).pipe(
          Effect.catchTag("SchemaError", () => unencodable("a login's sites")),
        );
        rows.push(yield* sealedRow(key, id, "origins", utf8(origins)));
      }
      if (draft.username !== undefined) {
        rows.push(yield* sealedRow(key, id, "username", utf8(Redacted.value(draft.username))));
      }
      if (draft.password !== undefined) {
        rows.push(yield* sealedRow(key, id, "password", utf8(Redacted.value(draft.password))));
      }
      if (draft.totp !== undefined && draft.totp !== null) {
        const config = parseTotpSetup(Redacted.value(draft.totp));
        if (Option.isNone(config)) return yield* new Invalid({ reason: "totp" });
        const sealed = yield* Schema.encodeEffect(TotpJson)(config.value).pipe(
          Effect.catchTag("SchemaError", () => unencodable("a login's code generator")),
        );
        rows.push(yield* sealedRow(key, id, "totp", utf8(sealed)));
      }
      return rows;
    });

    const writeRows = (
      sql: SqlClient.SqlClient,
      id: string,
      rows: ReadonlyArray<{ field: string; nonce: string; sealed: string }>,
    ) =>
      Effect.forEach(
        rows,
        (row) => sql`
          INSERT INTO record_fields (record_id, field, nonce, sealed)
          VALUES (${id}, ${row.field}, ${row.nonce}, ${row.sealed})
          ON CONFLICT (record_id, field) DO UPDATE SET nonce = excluded.nonce, sealed = excluded.sealed
        `,
        { discard: true },
      ).pipe(Effect.orDie);

    const changed = Effect.gen(function* () {
      revision += 1;
      yield* publish((yield* SubscriptionRef.get(state)).state);
    });

    const save = (input: {
      readonly id: CredentialId;
      readonly draft: CredentialDraft;
      readonly allowedBots: ReadonlyArray<BotId>;
    }) =>
      serial(
        Effect.gen(function* () {
          const { sql, key } = yield* unlocked;
          const existing = yield* readCredentials(sql, key, Option.some(input.id));
          const [saved] = existing;
          if (saved !== undefined) return { credential: saved, created: false };
          const allowed = yield* allowedOf(input.allowedBots);
          const rows = yield* sealedDraft(key, input.id, input.draft);
          const now = timeText(yield* DateTime.now);
          yield* transactional(sql)(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO records (id, kind, created_at, updated_at)
                VALUES (${input.id}, 'credential', ${now}, ${now})
              `.pipe(Effect.orDie);
              yield* writeRows(sql, input.id, rows);
              yield* Effect.forEach(
                allowed,
                (botId) => sql`
                  INSERT INTO record_bots (record_id, bot_id) VALUES (${input.id}, ${botId})
                `,
                { discard: true },
              ).pipe(Effect.orDie);
            }),
          );
          yield* Effect.logInfo("A login was saved in the vault").pipe(
            Effect.annotateLogs({ credentialId: input.id }),
          );
          yield* changed;
          return { credential: yield* credentialOf(sql, key, input.id), created: true };
        }),
      );

    const update = (input: {
      readonly id: CredentialId;
      readonly changes: Partial<CredentialDraft>;
    }) =>
      serial(
        Effect.gen(function* () {
          const { sql, key } = yield* unlocked;
          yield* credentialOf(sql, key, input.id);
          const rows = yield* sealedDraft(key, input.id, input.changes);
          yield* transactional(sql)(
            Effect.gen(function* () {
              yield* writeRows(sql, input.id, rows);
              if (input.changes.totp === null) {
                yield* sql`
                  DELETE FROM record_fields WHERE record_id = ${input.id} AND field = 'totp'
                `.pipe(Effect.orDie);
              }
              yield* sql`
                UPDATE records SET updated_at = ${timeText(yield* DateTime.now)}
                WHERE id = ${input.id}
              `.pipe(Effect.orDie);
            }),
          );
          yield* Effect.logInfo("A login in the vault was changed").pipe(
            Effect.annotateLogs({ credentialId: input.id }),
          );
          yield* changed;
          return yield* credentialOf(sql, key, input.id);
        }),
      );

    const remove = (id: CredentialId) =>
      serial(
        Effect.gen(function* () {
          const { sql } = yield* unlocked;
          const deleted = yield* sql`DELETE FROM records WHERE id = ${id} RETURNING id`.pipe(
            Effect.orDie,
          );
          if (deleted.length === 0) return;
          yield* Effect.logInfo("A login was deleted from the vault").pipe(
            Effect.annotateLogs({ credentialId: id }),
          );
          yield* changed;
        }),
      );

    const setAllowedBots = (id: CredentialId, ids: ReadonlyArray<BotId>) =>
      serial(
        Effect.gen(function* () {
          const { sql, key } = yield* unlocked;
          yield* credentialOf(sql, key, id);
          const allowed = yield* allowedOf(ids);
          yield* transactional(sql)(
            Effect.gen(function* () {
              yield* sql`DELETE FROM record_bots WHERE record_id = ${id}`.pipe(Effect.orDie);
              yield* Effect.forEach(
                allowed,
                (botId) => sql`
                  INSERT INTO record_bots (record_id, bot_id) VALUES (${id}, ${botId})
                `,
                { discard: true },
              ).pipe(Effect.orDie);
              yield* sql`
                UPDATE records SET updated_at = ${timeText(yield* DateTime.now)} WHERE id = ${id}
              `.pipe(Effect.orDie);
            }),
          );
          yield* changed;
          return yield* credentialOf(sql, key, id);
        }),
      );

    /** One sealed field of a login, opened; `NotFound` for a login without it. */
    const openedField = Effect.fn("Vault.openedField")(function* (
      sql: SqlClient.SqlClient,
      key: Uint8Array,
      id: CredentialId,
      field: CredentialSealedField,
    ) {
      yield* credentialOf(sql, key, id);
      const [row] = yield* fieldsOf(sql, [id], [field]);
      if (row === undefined) return yield* new NotFound({ resource: "credential" });
      return yield* openRow(key, row);
    });

    const totpOf = (id: CredentialId, bytes: Buffer) =>
      readBack(id, "totp", Schema.decodeEffect(TotpJson)(text(bytes)));

    const reveal = (input: {
      readonly id: CredentialId;
      readonly field: CredentialField;
      readonly deviceId: DeviceId;
    }) =>
      serial(
        Effect.gen(function* () {
          const { sql, key } = yield* unlocked;
          const opened = yield* openedField(sql, key, input.id, input.field);
          const value =
            input.field === "totp" ? (yield* totpOf(input.id, opened)).secret : text(opened);
          yield* sql`
            INSERT INTO reveals (record_id, field, device_id, at)
            VALUES (${input.id}, ${input.field}, ${input.deviceId}, ${timeText(yield* DateTime.now)})
          `.pipe(Effect.orDie);
          yield* Effect.logInfo("A vault value was shown").pipe(
            Effect.annotateLogs({
              credentialId: input.id,
              field: input.field,
              deviceId: input.deviceId,
            }),
          );
          yield* changed;
          return Redacted.make(value);
        }),
      );

    const totpPreview = (id: CredentialId) =>
      serial(
        Effect.gen(function* () {
          const { sql, key } = yield* unlocked;
          const config = yield* totpOf(id, yield* openedField(sql, key, id, "totp"));
          const now = yield* DateTime.now;
          const code = totpAt(config, Math.floor(DateTime.toEpochMillis(now) / 1000));
          if (Option.isNone(code)) return yield* damaged(id, "totp");
          return {
            code: Redacted.make(code.value.code),
            validUntil: DateTime.makeUnsafe(code.value.nextAt * 1000),
          };
        }),
      );

    const fillValue = (input: { readonly id: CredentialId; readonly field: CredentialField }) =>
      serial(
        Effect.gen(function* () {
          const { sql, key } = yield* unlocked;
          const credential = yield* credentialOf(sql, key, input.id);
          const opened = yield* openedField(sql, key, input.id, input.field);
          if (input.field !== "totp") {
            const value = text(opened);
            if (value === "") return yield* new NotFound({ resource: "credential" });
            return { value: Redacted.make(value), credential };
          }
          const config = yield* totpOf(input.id, opened);
          const now = yield* DateTime.now;
          const code = totpAt(config, Math.floor(DateTime.toEpochMillis(now) / 1000));
          if (Option.isNone(code)) return yield* damaged(input.id, "totp");
          return { value: Redacted.make(code.value.code), credential };
        }),
      );

    // ---- Connectors' secrets ----------------------------------------------------------

    const connectorSecret = (id: ConnectorId) =>
      serial(
        Effect.gen(function* () {
          const { sql, key } = yield* unlocked;
          const recordId = connectorRecordId(id);
          const rows = yield* fieldsOf(sql, [recordId], CONNECTOR_FIELDS);
          if (rows.length === 0) return Option.none<ConnectorSecret>();
          const opened = (field: (typeof CONNECTOR_FIELDS)[number]) => {
            const row = rows.find((candidate) => candidate.field === field);
            return row === undefined
              ? damaged(recordId, field)
              : Effect.map(openRow(key, row), text);
          };
          const oauth = yield* readBack(
            recordId,
            "oauth",
            Schema.decodeEffect(ConnectorOAuthJson)(yield* opened("oauth")),
          );
          const headers = yield* readBack(
            recordId,
            "headers",
            Schema.decodeEffect(NamedSecretsJson)(yield* opened("headers")),
          );
          const env = yield* readBack(
            recordId,
            "env",
            Schema.decodeEffect(NamedSecretsJson)(yield* opened("env")),
          );
          return Option.some<ConnectorSecret>({ connectorId: id, oauth, headers, env });
        }),
      );

    const putConnectorSecret = (secret: ConnectorSecret) =>
      serial(
        Effect.gen(function* () {
          const { sql, key } = yield* unlocked;
          const recordId = connectorRecordId(secret.connectorId);
          const oauth = yield* Schema.encodeEffect(ConnectorOAuthJson)(secret.oauth);
          const headers = yield* Schema.encodeEffect(NamedSecretsJson)(secret.headers);
          const env = yield* Schema.encodeEffect(NamedSecretsJson)(secret.env);
          const rows = [
            yield* sealedRow(key, recordId, "oauth", utf8(oauth)),
            yield* sealedRow(key, recordId, "headers", utf8(headers)),
            yield* sealedRow(key, recordId, "env", utf8(env)),
          ];
          const now = timeText(yield* DateTime.now);
          yield* transactional(sql)(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO records (id, kind, created_at, updated_at)
                VALUES (${recordId}, 'connector', ${now}, ${now})
                ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at
              `.pipe(Effect.orDie);
              yield* writeRows(sql, recordId, rows);
            }),
          );
        }).pipe(Effect.catchTag("SchemaError", () => unencodable("a connector's secret"))),
      );

    const removeConnectorSecret = (id: ConnectorId) =>
      serial(
        Effect.gen(function* () {
          const { sql } = yield* unlocked;
          yield* sql`DELETE FROM records WHERE id = ${connectorRecordId(id)}`.pipe(Effect.orDie);
        }),
      );

    return Vault.of({
      status: SubscriptionRef.changes(state),
      setup,
      unlock,
      lock,
      changePassword,
      list,
      reveal,
      save,
      update,
      remove,
      setAllowedBots,
      totpPreview,
      fillValue,
      connectorSecrets: {
        get: connectorSecret,
        put: putConnectorSecret,
        remove: removeConnectorSecret,
      },
    });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
