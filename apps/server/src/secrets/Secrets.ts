// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import {
  accessAllows,
  BotId,
  Conflict,
  DeviceId,
  type EntryId,
  type FillField,
  Invalid,
  LoginOrigins,
  NotFound,
  type Secret,
  type SecretAccess,
  type SecretChanges,
  type SecretDraft,
  SecretField,
  SecretId,
  SecretName,
  type SecretsState,
  type SecretsStatus,
  SecretUse,
  type TotpPreview,
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
import { removeLeftovers, replaceFileDurably } from "../files.ts";
import { ServerConfig } from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import { Layout } from "../Layout.ts";
import { json, Time, timeText } from "../persistence/columns.ts";
import { migrate } from "../persistence/Migrations.ts";
import { transactional } from "../persistence/transaction.ts";
import {
  KEY_BYTES,
  kdfParamsInRange,
  NONCE_BYTES,
  openField,
  type Sealed,
  sealField,
  unwrapDataKey,
  withDerivedKey,
} from "./crypto.ts";
import {
  type ConnectorId,
  ConnectorSecret,
  connectorRecordId,
  NamedSecret,
} from "./ConnectorSecret.ts";
import Migration0001 from "./migrations/0001_initial.ts";
import Migration0002 from "./migrations/0002_secrets.ts";
import { accessCovers, nameFromLabel, referenceText, type SecretReference } from "./references.ts";
import { parseTotpSetup, TotpConfig, totpAt } from "./totp.ts";

/** The secrets' file, inside their own folder of the home. */
export const SECRETS_FILE = "vault.sqlite";

/** The key file beside it: the data key every value is sealed under. */
export const KEY_FILE = "key";

/** The secrets' migrations, forward only, like the database's (`persistence/Migrations.ts`). */
const migrations = SqliteMigrator.fromRecord({
  "1_initial": Migration0001,
  "2_secrets": Migration0002,
});

/** The first line of the key file, which says what the second holds. */
const KEY_FILE_HEADER = "j3-bots secrets key v1";

/**
 * How seldom a secret's last use is written again for the same bot and the
 * same place: a connector may send it with every request.
 */
const USE_WRITTEN_EVERY = Duration.minutes(1);

/** The record and field the key check is sealed for: no record has that id. */
const KEY_CHECK_RECORD = "key-check";
const KEY_CHECK_FIELD = "key";
const KEY_CHECK_TEXT = "j3-bots secrets";

const KeyringRow = Schema.Struct({
  kdf_n: Schema.Int,
  kdf_r: Schema.Int,
  kdf_p: Schema.Int,
  salt: Schema.String,
  key_nonce: Schema.String,
  wrapped_key: Schema.String,
});

const SealedRow = Schema.Struct({ nonce: Schema.String, sealed: Schema.String });

const SecretRow = Schema.Struct({
  id: SecretId,
  kind: Schema.Literals(["login", "value"]),
  name: Schema.NullOr(Schema.String),
  every_bot: Schema.BooleanFromBit,
  used_at: Schema.NullOr(Time),
  used_by: Schema.NullOr(BotId),
  used_for: Schema.NullOr(Schema.String),
  created_at: Time,
  updated_at: Time,
});
type SecretRow = typeof SecretRow.Type;

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
  field: SecretField,
  device_id: DeviceId,
  at: Time,
});

/** The fields a secret seals: a login's four, or a single value's one. */
type SealedField = "origins" | "username" | "password" | "totp" | "value";

const OriginsJson = json(LoginOrigins);
const TotpJson = json(TotpConfig);
const UseJson = json(SecretUse);
const ConnectorAddressJson = json(ConnectorSecret.fields.address);
const ConnectorOAuthJson = json(ConnectorSecret.fields.oauth);
const NamedSecretsJson = json(Schema.Array(NamedSecret));
const CommandJson = json(ConnectorSecret.fields.command);

const decodeName = Schema.decodeUnknownOption(SecretName);

/** The fields a connector's record seals, one value each. */
const CONNECTOR_FIELDS = ["address", "oauth", "headers", "command", "env", "formSecrets"] as const;

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytesOf = (text: string) => Buffer.from(text, "base64");
const utf8 = (text: string) => Buffer.from(text, "utf8");

/**
 * A value the caller gave that does not encode for the file. Its types rule
 * that out; should it happen, the defect says so without the value, which the
 * encoder's own error could carry.
 */
const unencodable = (what: string) =>
  Effect.die(new Error(`The secrets could not encode ${what}.`));

/** What every request but the status and opening an old vault answers in a state but `ready`. */
const notReady = () => new Conflict({ reason: "secrets-unavailable" });

/**
 * Why a reference could not be given its value. It names the secret, never a
 * value: a connector reports it as its call's failure.
 *
 * - `missing`: no secret has that name;
 * - `not-allowed`: a bot that would use it may not;
 * - `no-value`: the reference names a value it does not have, such as a
 *   single value's user name;
 * - `unavailable`: the secrets cannot be read now (`SecretsState`), or the
 *   value does not open.
 */
export class SecretUnavailable extends Schema.TaggedError<SecretUnavailable>()(
  "SecretUnavailable",
  {
    secret: SecretName,
    reason: Schema.Literals(["missing", "not-allowed", "no-value", "unavailable"]),
  },
) {
  override get message(): string {
    return `The secret "${this.secret}" cannot be used: ${this.reason}.`;
  }
}

/**
 * The operator's secrets (`docs/architecture/server.md`, "Secrets"): logins
 * and single values, sealed under a data key the server keeps in a key file
 * of its own, and a connector's secrets beside them. Nothing unlocks them:
 * they work from the server's start, except while a vault from before secrets
 * waits for its password one last time. Every value comes and goes as a
 * redacted type, and nothing here logs one or puts one in an error.
 */
export class Secrets extends Context.Service<
  Secrets,
  {
    /** The status now, then each change. */
    readonly status: Stream.Stream<SecretsStatus>;
    /**
     * Opens a vault from before secrets with its master password, once: the
     * data key goes to the key file, each login gets a name, and the
     * password's keyring is deleted. Does nothing in `ready`.
     */
    readonly openOldVault: (
      password: Redacted.Redacted<string>,
    ) => Effect.Effect<void, Conflict | Invalid>;
    readonly list: Effect.Effect<ReadonlyArray<Secret>, Conflict>;
    /** The secrets `botId` may use. */
    readonly usableBy: (botId: BotId) => Effect.Effect<ReadonlyArray<Secret>, Conflict>;
    /** The secret named `name`, whichever bots may use it. */
    readonly named: (name: SecretName) => Effect.Effect<Option.Option<Secret>, Conflict>;
    /** One value, recording when it was shown and on which device. */
    readonly reveal: (input: {
      readonly id: SecretId;
      readonly field: SecretField;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<Redacted.Redacted<string>, Conflict | NotFound>;
    /**
     * Adds a secret as `id`. When `id` is added already, nothing changes and
     * `created` is false; so too when a secret of that name was added from
     * the same ask (`askedIn`, the card's entry), under another id, as a
     * device that lost the first answer sends it again.
     */
    readonly add: (input: {
      readonly id: SecretId;
      readonly name: SecretName;
      readonly draft: SecretDraft;
      readonly access: SecretAccess;
      readonly askedIn?: EntryId | undefined;
    }) => Effect.Effect<
      { readonly secret: Secret; readonly created: boolean },
      Conflict | Invalid | NotFound
    >;
    /** Which of the asks of `entries` a secret was added from. */
    readonly askedIn: (
      entries: ReadonlyArray<EntryId>,
    ) => Effect.Effect<ReadonlySet<string>, Conflict>;
    readonly update: (input: {
      readonly id: SecretId;
      readonly changes: SecretChanges;
    }) => Effect.Effect<Secret, Conflict | Invalid | NotFound>;
    readonly remove: (id: SecretId) => Effect.Effect<void, Conflict>;
    readonly setAccess: (
      id: SecretId,
      access: SecretAccess,
    ) => Effect.Effect<Secret, Conflict | NotFound>;
    readonly totpPreview: (id: SecretId) => Effect.Effect<TotpPreview, Conflict | NotFound>;
    /**
     * A login's value for the server to type into `botId`'s browser tab on
     * a page of `origin` (`Fill.ts`): its user name, its password, or its
     * one-time code now, with the login as it was when the value was opened,
     * read together so no change to the login falls between them. Fails
     * with `NotFound("secret")` for a login without that value, an empty
     * user name included. Records nothing: the fill may still type nothing.
     */
    readonly fillValue: (input: {
      readonly id: SecretId;
      readonly field: FillField;
    }) => Effect.Effect<
      { readonly value: Redacted.Redacted<string>; readonly secret: Secret },
      Conflict | NotFound
    >;
    /**
     * Records that `botId` used the login at `use`, once the browser took
     * what was typed: a use, not a reveal, since no device saw it.
     */
    readonly filled: (input: {
      readonly id: SecretId;
      readonly botId: BotId;
      readonly use: SecretUse;
    }) => Effect.Effect<void, Conflict>;
    /**
     * The value of each of `references`, keyed by its text (`referenceText`),
     * for a connector that `users` use: each must name a secret every one of
     * them may use, with the value it names. Records no use: the server
     * resolves a connector's settings once for all its bots, and records a
     * bot's use when its call goes out (`noteUse`). Never logs a value.
     */
    readonly referenceValues: (input: {
      readonly references: ReadonlyArray<SecretReference>;
      readonly users: SecretAccess;
    }) => Effect.Effect<ReadonlyMap<string, Redacted.Redacted<string>>, SecretUnavailable>;
    /**
     * Records that `botId` used the secrets named `names` at `use`. A name no
     * secret has is passed over.
     */
    readonly noteUse: (input: {
      readonly names: ReadonlyArray<SecretName>;
      readonly botId: BotId;
      readonly use: SecretUse;
    }) => Effect.Effect<void, Conflict>;
    /**
     * What connectors need to reach their servers: OAuth clients and tokens,
     * headers and environment values. Not a secret of the operator's list,
     * and none of these changes `revision`. Each fails with the state's
     * conflict while the secrets cannot be read, which a connector reports as
     * its own state.
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
>()("@j3-bots/server/secrets/Secrets") {}

/** The secrets' database, open and migrated, or left alone because a newer release wrote it. */
type SecretsFile =
  | { readonly _tag: "open"; readonly sql: SqlClient.SqlClient }
  | { readonly _tag: "newer" };

/**
 * Opens the secrets' database at `location`, migrated. One that records a
 * migration this release does not know is left as it is: the release that
 * wrote it can still read it, so it is refused here without stopping the
 * server.
 */
const openSecretsFile = Effect.fn("Secrets.open")(function* (location: string) {
  const sql = yield* SqliteClient.make({ filename: location });
  const provided = Effect.provideService(SqlClient.SqlClient, sql);
  yield* sql`PRAGMA foreign_keys = ON`;
  // What is deleted is overwritten, not only unlinked: a deleted value, or an
  // old vault's keyring, never stays readable in the file's free space.
  yield* sql`PRAGMA secure_delete = ON`;
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
        "A newer release of J3 Bots changed the secrets, which this one cannot read; they stay as they are",
      );
      return { _tag: "newer" } as const satisfies SecretsFile;
    }
  }
  yield* provided(migrate(migrations));
  return { _tag: "open", sql } as const satisfies SecretsFile;
});

/** The key file's text for `key`. */
const keyFileText = (key: Uint8Array) => `${KEY_FILE_HEADER}\n${base64(key)}\n`;

/** The key a key file's text holds; none when it is not one. */
const keyOfText = (text: string): Option.Option<Buffer> => {
  const [header, encoded] = text.split("\n");
  if (header !== KEY_FILE_HEADER || encoded === undefined) return Option.none();
  const key = bytesOf(encoded);
  if (key.length === KEY_BYTES) return Option.some(key);
  key.fill(0);
  return Option.none();
};

export const layer = Layer.effect(
  Secrets,
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = yield* Layout;
    const bots = yield* BotStore;
    const random = yield* SecureRandom.SecureRandom;

    const folder = yield* layout.writable(path.join(home, HOME_ENTRIES.secrets)).pipe(Effect.orDie);
    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
    yield* fs.chmod(folder, 0o700).pipe(Effect.orDie);
    // A key file's write the server was stopped in can leave the key in a
    // temporary file beside it.
    yield* removeLeftovers(folder).pipe(Effect.orDie);
    const keyFile = path.join(folder, KEY_FILE);
    const file: SecretsFile = yield* openSecretsFile(path.join(folder, SECRETS_FILE)).pipe(
      Effect.provide(Reactivity.layer),
      Effect.orDie,
    );

    const randomBuffer = (size: number) =>
      Effect.map(random.randomBytes(size), (bytes) => {
        const copy = Buffer.alloc(size);
        copy.set(bytes);
        bytes.fill(0);
        return copy;
      });

    /** The key file's key, or none when there is no key file or it holds none. */
    const readKeyFile = Effect.gen(function* () {
      if (!(yield* fs.exists(keyFile))) return Option.none<Buffer>();
      return keyOfText(yield* fs.readFileString(keyFile));
    }).pipe(Effect.orDie);

    /**
     * Writes `key` to the key file, private to the server's user, replacing
     * any, and flushes it to the disk: what is written after it (the key
     * check, an old vault's keyring deleted) never outlives it in a power cut.
     */
    const writeKeyFile = (key: Uint8Array) =>
      replaceFileDurably(keyFile, keyFileText(key), 0o600).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.orDie,
      );

    const keyringOf = (sql: SqlClient.SqlClient) =>
      SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: KeyringRow,
        execute: () => sql`
          SELECT kdf_n, kdf_r, kdf_p, salt, key_nonce, wrapped_key FROM keyring WHERE id = 1
        `,
      })(undefined).pipe(Effect.orDie);

    const keyCheckOf = (sql: SqlClient.SqlClient) =>
      SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: SealedRow,
        execute: () => sql`SELECT nonce, sealed FROM key_check WHERE id = 1`,
      })(undefined).pipe(Effect.orDie);

    const hasRecords = (sql: SqlClient.SqlClient) =>
      Effect.map(sql`SELECT 1 FROM records LIMIT 1`.pipe(Effect.orDie), (rows) => rows.length > 0);

    /** Whether `key` is the one the key check was sealed under. */
    const opensCheck = (key: Uint8Array, check: typeof SealedRow.Type) =>
      Option.match(
        openField(key, KEY_CHECK_RECORD, KEY_CHECK_FIELD, {
          nonce: bytesOf(check.nonce),
          sealed: bytesOf(check.sealed),
        }),
        {
          onNone: () => false,
          onSome: (plain) => {
            const right = plain.toString("utf8") === KEY_CHECK_TEXT;
            plain.fill(0);
            return right;
          },
        },
      );

    /** The key check for `key`, sealed. */
    const keyCheckRow = (key: Uint8Array) =>
      Effect.map(randomBuffer(NONCE_BYTES), (nonce) => {
        const value = sealField(
          key,
          KEY_CHECK_RECORD,
          KEY_CHECK_FIELD,
          utf8(KEY_CHECK_TEXT),
          nonce,
        );
        return { nonce: base64(value.nonce), sealed: base64(value.sealed) };
      });

    const writeKeyCheck = Effect.fn("Secrets.writeKeyCheck")(function* (
      sql: SqlClient.SqlClient,
      key: Uint8Array,
    ) {
      const row = yield* keyCheckRow(key);
      yield* sql`
        INSERT INTO key_check (id, nonce, sealed, created_at)
        VALUES (1, ${row.nonce}, ${row.sealed}, ${timeText(yield* DateTime.now)})
        ON CONFLICT (id) DO UPDATE SET nonce = excluded.nonce, sealed = excluded.sealed
      `.pipe(Effect.orDie);
    });

    /**
     * The state at start, and the data key in `ready`:
     *
     * - a vault from before secrets, with a keyring, waits for its password,
     *   unless it holds nothing, when the keyring goes and a key file is made;
     * - with a key check, the key file must hold the key it was sealed under,
     *   or the secrets are `unreadable`;
     * - with neither, nothing was ever sealed: the key file's key is used, or
     *   one is made, and the check is written.
     */
    const start = Effect.fn("Secrets.start")(function* (sql: SqlClient.SqlClient) {
      const keyring = yield* keyringOf(sql);
      const anything = yield* hasRecords(sql);
      if (Option.isSome(keyring)) {
        if (anything) return { state: "old-vault", key: null } as const;
        yield* sql`DELETE FROM keyring`.pipe(Effect.orDie);
        yield* Effect.logInfo("An empty vault from before secrets was replaced by a key file");
      }
      const check = yield* keyCheckOf(sql);
      const stored = yield* readKeyFile;
      if (Option.isSome(check)) {
        if (Option.isSome(stored) && opensCheck(stored.value, check.value)) {
          return { state: "ready", key: stored.value } as const;
        }
        if (Option.isSome(stored)) stored.value.fill(0);
        yield* Effect.logError(
          "The secrets' key file is missing or holds another key: the secrets cannot be read",
        );
        return { state: "unreadable", key: null } as const;
      }
      if (anything) {
        if (Option.isSome(stored)) stored.value.fill(0);
        yield* Effect.logError(
          "The secrets hold values but no key check: the secrets cannot be read",
        );
        return { state: "unreadable", key: null } as const;
      }
      const key = Option.isSome(stored) ? stored.value : yield* randomBuffer(KEY_BYTES);
      if (Option.isNone(stored)) yield* writeKeyFile(key);
      yield* writeKeyCheck(sql, key);
      return { state: "ready", key } as const;
    });

    const started =
      file._tag === "newer" ? ({ state: "newer", key: null } as const) : yield* start(file.sql);

    /** The data key in `ready`; zeroed when the server stops. */
    let dataKey: Buffer | null = started.key;
    let revision = 0;
    const state = yield* SubscriptionRef.make<SecretsStatus>({ state: started.state, revision });

    const publish = (next: SecretsState) => SubscriptionRef.set(state, { state: next, revision });

    /** One request at a time: none reads the key while another replaces it. */
    const exclusive = Semaphore.makeUnsafe(1);
    const serial = <A, E, R>(effect: Effect.Effect<A, E, R>) => exclusive.withPermit(effect);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (dataKey !== null) dataKey.fill(0);
        dataKey = null;
      }),
    );

    /** The open database and the data key, or the conflict the state is. */
    const ready = Effect.gen(function* () {
      if (file._tag === "open" && dataKey !== null) return { sql: file.sql, key: dataKey };
      return yield* notReady();
    });

    /**
     * A value that does not open under the key or read back as what it
     * should be. The log names the record and field, never the value, and
     * the caller gets a refusal it can show.
     */
    const damaged = (recordId: string, field: string) =>
      Effect.logError("A secret's value does not open or read back: its file was changed").pipe(
        Effect.annotateLogs({ recordId, field }),
        Effect.andThen(Effect.fail(new Conflict({ reason: "secrets-damaged" }))),
      );

    /** `decoded`, a value read back from the file, or `damaged` without the decoder's error. */
    const readBack = <A, R>(
      recordId: string,
      field: string,
      decoded: Effect.Effect<A, Schema.SchemaError, R>,
    ) => decoded.pipe(Effect.catchTag("SchemaError", () => damaged(recordId, field)));

    const sealedRow = <Field extends string>(
      key: Uint8Array,
      id: string,
      field: Field,
      plain: Uint8Array,
    ) =>
      Effect.map(randomBuffer(NONCE_BYTES), (nonce) => {
        const value = sealField(key, id, field, plain, nonce);
        plain.fill(0);
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

    // ---- An old vault, opened once --------------------------------------------------

    const openOldVault = (password: Redacted.Redacted<string>) =>
      serial(
        Effect.gen(function* () {
          if (file._tag === "newer") return yield* notReady();
          const current = (yield* SubscriptionRef.get(state)).state;
          if (current === "ready") return;
          if (current !== "old-vault") return yield* notReady();
          const sql = file.sql;
          const keyring = yield* keyringOf(sql);
          if (Option.isNone(keyring)) return yield* notReady();
          const params = { n: keyring.value.kdf_n, r: keyring.value.kdf_r, p: keyring.value.kdf_p };
          if (!kdfParamsInRange(params)) {
            yield* Effect.logError(
              "The old vault's key settings are out of range: its file was changed",
            ).pipe(Effect.annotateLogs({ n: params.n, r: params.r, p: params.p }));
            return yield* new Conflict({ reason: "secrets-damaged" });
          }
          const key = yield* withDerivedKey(password, bytesOf(keyring.value.salt), params, (kek) =>
            Effect.succeed(
              unwrapDataKey(kek, {
                nonce: bytesOf(keyring.value.key_nonce),
                sealed: bytesOf(keyring.value.wrapped_key),
              }),
            ),
          );
          if (Option.isNone(key)) {
            yield* Effect.logWarning("A wrong password was given for the old vault");
            return yield* new Invalid({ reason: "old-vault-password" });
          }
          // Each login's name, opened while nothing else is written, before
          // anything changes: a name that does not open leaves the vault as
          // it was.
          const logins = yield* SqlSchema.findAll({
            Request: Schema.Void,
            Result: Schema.Struct({ id: Schema.String }),
            execute: () => sql`SELECT id FROM records WHERE kind = 'login' ORDER BY created_at, id`,
          })(undefined).pipe(Effect.orDie);
          const nameRows = yield* fieldsOf(
            sql,
            logins.map(({ id }) => id),
            ["name"],
          );
          const taken = new Set<string>();
          const names: Array<{ readonly id: string; readonly name: SecretName }> = [];
          for (const { id } of logins) {
            const row = nameRows.find((candidate) => candidate.record_id === id);
            const label = row === undefined ? "" : text(yield* openRow(key.value, row));
            const name = nameFromLabel(label, taken);
            taken.add(name);
            names.push({ id, name });
          }
          // The key file first: a stop between the two leaves the keyring,
          // so the password opens it again, and the same key is written.
          yield* writeKeyFile(key.value);
          yield* transactional(sql)(
            Effect.gen(function* () {
              for (const { id, name } of names) {
                yield* sql`UPDATE records SET name = ${name} WHERE id = ${id}`.pipe(Effect.orDie);
              }
              yield* sql`DELETE FROM record_fields WHERE field = 'name'`.pipe(Effect.orDie);
              yield* writeKeyCheck(sql, key.value);
              yield* sql`DELETE FROM keyring`.pipe(Effect.orDie);
            }),
          );
          // The pages the keyring was on, as they were, are in the write-ahead
          // log until it is written back and emptied.
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(Effect.orDie);
          dataKey = key.value;
          revision += 1;
          yield* Effect.logInfo(
            "The old vault was opened; the server keeps its key from now on",
          ).pipe(Effect.annotateLogs({ logins: names.length }));
          yield* publish("ready");
        }),
      );

    // ---- Secrets ------------------------------------------------------------------

    /** The ids of the bots that exist now. */
    const knownBots = Effect.map(
      bots.list,
      (rows): ReadonlySet<string> => new Set(rows.map(({ bot }) => bot.id)),
    );

    /**
     * `serial`, for a request that reads which bots may use a secret: the
     * bots are read before its turn, from the main database, so no request
     * waits on that database while it holds the secrets, and none that holds
     * the main database's transaction (a bot's tool) waits on one that does.
     */
    const serialKnowing = <A, E, R>(
      effect: (known: ReadonlySet<string>) => Effect.Effect<A, E, R>,
    ) => Effect.flatMap(knownBots, (known) => serial(effect(known)));

    const secretRows = (sql: SqlClient.SqlClient, only: Option.Option<string>) =>
      SqlSchema.findAll({
        Request: Schema.Void,
        Result: SecretRow,
        execute: () =>
          Option.match(only, {
            onNone: () => sql`
              SELECT id, kind, name, every_bot, used_at, used_by, used_for, created_at, updated_at
              FROM records WHERE kind IN ('login', 'value') ORDER BY name
            `,
            onSome: (id) => sql`
              SELECT id, kind, name, every_bot, used_at, used_by, used_for, created_at, updated_at
              FROM records WHERE kind IN ('login', 'value') AND id = ${id}
            `,
          }),
      })(undefined).pipe(Effect.orDie);

    /** Every secret, or the one of `only`, without its values. */
    const readSecrets = Effect.fn("Secrets.readSecrets")(function* (
      sql: SqlClient.SqlClient,
      key: Uint8Array,
      only: Option.Option<string>,
      known: ReadonlySet<string>,
    ) {
      const records = yield* secretRows(sql, only);
      const ids = records.map(({ id }) => id);
      const fields = yield* fieldsOf(sql, ids, ["origins", "totp"]);
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
      const secrets: Array<Secret> = [];
      for (const record of records) {
        secrets.push(
          yield* secretOf(key, record, {
            fields: fields.filter((row) => row.record_id === record.id),
            botIds: allowed.flatMap((row) =>
              row.record_id === record.id && known.has(row.bot_id) ? [row.bot_id] : [],
            ),
            reveal: reveals.find((row) => row.record_id === record.id),
          }),
        );
      }
      return secrets;
    });

    const secretOf = Effect.fn("Secrets.secretOf")(function* (
      key: Uint8Array,
      record: SecretRow,
      parts: {
        readonly fields: ReadonlyArray<FieldRow>;
        readonly botIds: ReadonlyArray<BotId>;
        readonly reveal: typeof RevealRow.Type | undefined;
      },
    ) {
      const name = decodeName(record.name);
      if (Option.isNone(name)) return yield* damaged(record.id, "name");
      let kind: Secret["kind"];
      if (record.kind === "login") {
        const originsRow = parts.fields.find((row) => row.field === "origins");
        if (originsRow === undefined) return yield* damaged(record.id, "origins");
        const origins = yield* readBack(
          record.id,
          "origins",
          Schema.decodeEffect(OriginsJson)(text(yield* openRow(key, originsRow))),
        );
        kind = {
          _tag: "login",
          origins,
          hasTotp: parts.fields.some((row) => row.field === "totp"),
        };
      } else {
        kind = { _tag: "value" };
      }
      const use =
        record.used_at === null || record.used_by === null || record.used_for === null
          ? Option.none()
          : Schema.decodeOption(UseJson)(record.used_for);
      const { reveal } = parts;
      return {
        id: record.id,
        name: name.value,
        kind,
        access: record.every_bot ? { _tag: "every-bot" } : { _tag: "bots", botIds: parts.botIds },
        createdAt: record.created_at,
        updatedAt: record.updated_at,
        lastUse:
          Option.isSome(use) && record.used_at !== null && record.used_by !== null
            ? { at: record.used_at, botId: record.used_by, use: use.value }
            : null,
        lastReveal:
          reveal === undefined
            ? null
            : { at: reveal.at, deviceId: reveal.device_id, field: reveal.field },
      } satisfies Secret;
    });

    const secretById = (
      sql: SqlClient.SqlClient,
      key: Uint8Array,
      id: SecretId,
      known: ReadonlySet<string>,
    ) =>
      Effect.flatMap(readSecrets(sql, key, Option.some(id), known), ([secret]) =>
        secret === undefined
          ? Effect.fail(new NotFound({ resource: "secret" }))
          : Effect.succeed(secret),
      );

    const list = serialKnowing((known) =>
      Effect.gen(function* () {
        const { sql, key } = yield* ready;
        return yield* readSecrets(sql, key, Option.none(), known);
      }),
    );

    const usableBy = (botId: BotId) =>
      Effect.map(list, (secrets) => secrets.filter((secret) => accessAllows(secret.access, botId)));

    const idNamed = (sql: SqlClient.SqlClient, name: string) =>
      SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: Schema.Struct({ id: SecretId }),
        execute: () => sql`
          SELECT id FROM records WHERE kind IN ('login', 'value') AND name = ${name}
        `,
      })(undefined).pipe(Effect.orDie, Effect.map(Option.map(({ id }) => id)));

    const named = (name: SecretName) =>
      serialKnowing((known) =>
        Effect.gen(function* () {
          const { sql, key } = yield* ready;
          const id = yield* idNamed(sql, name);
          if (Option.isNone(id)) return Option.none<Secret>();
          const [secret] = yield* readSecrets(sql, key, id, known);
          return Option.fromNullishOr(secret);
        }),
      );

    /** The bots of `access`, each once, refusing one that does not exist. */
    const checkedAccess = Effect.fn("Secrets.checkedAccess")(function* (
      access: SecretAccess,
      known: ReadonlySet<string>,
    ) {
      if (access._tag === "every-bot") return access;
      const unique = [...new Set(access.botIds)];
      if (!unique.every((id) => known.has(id))) {
        return yield* new NotFound({ resource: "bot" });
      }
      return { _tag: "bots", botIds: unique } satisfies SecretAccess;
    });

    const writeAccess = Effect.fn("Secrets.writeAccess")(function* (
      sql: SqlClient.SqlClient,
      id: string,
      access: SecretAccess,
    ) {
      yield* sql`DELETE FROM record_bots WHERE record_id = ${id}`;
      yield* sql`
          UPDATE records SET every_bot = ${access._tag === "every-bot" ? 1 : 0} WHERE id = ${id}
        `;
      if (access._tag === "every-bot") return;
      yield* Effect.forEach(
        access.botIds,
        (botId) => sql`INSERT INTO record_bots (record_id, bot_id) VALUES (${id}, ${botId})`,
        { discard: true },
      );
    }, Effect.orDie);

    /** The sealed rows for the values given; `totp: null` gives none. */
    const sealedValues = Effect.fn("Secrets.sealedValues")(function* (
      key: Uint8Array,
      id: string,
      values: {
        readonly origins?: LoginOrigins | undefined;
        readonly username?: Redacted.Redacted<string> | undefined;
        readonly password?: Redacted.Redacted<string> | undefined;
        readonly totp?: Redacted.Redacted<string> | null | undefined;
        readonly value?: Redacted.Redacted<string> | undefined;
      },
    ) {
      const rows: Array<{ field: SealedField; nonce: string; sealed: string }> = [];
      if (values.origins !== undefined) {
        const origins = yield* Schema.encodeEffect(OriginsJson)(values.origins).pipe(
          Effect.catchTag("SchemaError", () => unencodable("a login's sites")),
        );
        rows.push(yield* sealedRow(key, id, "origins", utf8(origins)));
      }
      for (const field of ["username", "password", "value"] as const) {
        const given = values[field];
        if (given !== undefined) {
          rows.push(yield* sealedRow(key, id, field, utf8(Redacted.value(given))));
        }
      }
      if (values.totp !== undefined && values.totp !== null) {
        const config = parseTotpSetup(Redacted.value(values.totp));
        if (Option.isNone(config)) return yield* new Invalid({ reason: "totp" });
        const sealed = yield* Schema.encodeEffect(TotpJson)(config.value).pipe(
          Effect.catchTag("SchemaError", () => unencodable("a login's code generator")),
        );
        rows.push(yield* sealedRow(key, id, "totp", utf8(sealed)));
      }
      return rows;
    });

    const changed = Effect.gen(function* () {
      revision += 1;
      yield* publish((yield* SubscriptionRef.get(state)).state);
    });

    const add = (input: {
      readonly id: SecretId;
      readonly name: SecretName;
      readonly draft: SecretDraft;
      readonly access: SecretAccess;
      readonly askedIn?: EntryId | undefined;
    }) =>
      serialKnowing((known) =>
        Effect.gen(function* () {
          const { sql, key } = yield* ready;
          const askedIn = input.askedIn ?? null;
          const [saved] = yield* readSecrets(sql, key, Option.some(input.id), known);
          if (saved !== undefined) return { secret: saved, created: false };
          const taken = yield* idNamed(sql, input.name);
          if (Option.isSome(taken)) {
            const [same] =
              askedIn === null
                ? []
                : yield* sql`
                    SELECT 1 FROM records WHERE id = ${taken.value} AND asked_in = ${askedIn}
                  `.pipe(Effect.orDie);
            if (same === undefined) return yield* new Conflict({ reason: "secret-name-taken" });
            return { secret: yield* secretById(sql, key, taken.value, known), created: false };
          }
          const access = yield* checkedAccess(input.access, known);
          const { draft } = input;
          const rows = yield* sealedValues(
            key,
            input.id,
            draft._tag === "login"
              ? {
                  origins: draft.origins,
                  username: draft.username,
                  password: draft.password,
                  totp: draft.totp,
                }
              : { value: draft.value },
          );
          const now = timeText(yield* DateTime.now);
          yield* transactional(sql)(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO records (id, kind, name, asked_in, created_at, updated_at)
                VALUES (${input.id}, ${draft._tag}, ${input.name}, ${askedIn}, ${now}, ${now})
              `.pipe(Effect.orDie);
              yield* writeRows(sql, input.id, rows);
              yield* writeAccess(sql, input.id, access);
            }),
          );
          yield* Effect.logInfo("A secret was added").pipe(
            Effect.annotateLogs({ secretId: input.id, kind: draft._tag }),
          );
          yield* changed;
          return { secret: yield* secretById(sql, key, input.id, known), created: true };
        }),
      );

    const askedIn = (ids: ReadonlyArray<EntryId>) =>
      serial(
        Effect.gen(function* () {
          const { sql } = yield* ready;
          if (ids.length === 0) return new Set<string>();
          const rows = yield* SqlSchema.findAll({
            Request: Schema.Void,
            Result: Schema.Struct({ asked_in: Schema.String }),
            execute: () => sql`
              SELECT asked_in FROM records WHERE ${sql.in("asked_in", ids)}
            `,
          })(undefined).pipe(Effect.orDie);
          return new Set<string>(rows.map((row) => row.asked_in));
        }),
      );

    const update = (input: { readonly id: SecretId; readonly changes: SecretChanges }) =>
      serialKnowing((known) =>
        Effect.gen(function* () {
          const { sql, key } = yield* ready;
          const current = yield* secretById(sql, key, input.id, known);
          const { changes } = input;
          const login =
            changes.origins !== undefined ||
            changes.username !== undefined ||
            changes.password !== undefined ||
            changes.totp !== undefined;
          if (
            (current.kind._tag === "value" && login) ||
            (current.kind._tag === "login" && changes.value !== undefined)
          ) {
            return yield* new Invalid({ reason: "secret-kind" });
          }
          if (changes.name !== undefined && changes.name !== current.name) {
            if (Option.isSome(yield* idNamed(sql, changes.name))) {
              return yield* new Conflict({ reason: "secret-name-taken" });
            }
          }
          const rows = yield* sealedValues(key, input.id, changes);
          yield* transactional(sql)(
            Effect.gen(function* () {
              yield* writeRows(sql, input.id, rows);
              if (changes.totp === null) {
                yield* sql`
                  DELETE FROM record_fields WHERE record_id = ${input.id} AND field = 'totp'
                `.pipe(Effect.orDie);
              }
              if (changes.name !== undefined) {
                yield* sql`UPDATE records SET name = ${changes.name} WHERE id = ${input.id}`.pipe(
                  Effect.orDie,
                );
              }
              yield* sql`
                UPDATE records SET updated_at = ${timeText(yield* DateTime.now)}
                WHERE id = ${input.id}
              `.pipe(Effect.orDie);
            }),
          );
          yield* Effect.logInfo("A secret was changed").pipe(
            Effect.annotateLogs({ secretId: input.id }),
          );
          yield* changed;
          return yield* secretById(sql, key, input.id, known);
        }),
      );

    const remove = (id: SecretId) =>
      serial(
        Effect.gen(function* () {
          const { sql } = yield* ready;
          const deleted = yield* sql`
            DELETE FROM records WHERE id = ${id} AND kind IN ('login', 'value') RETURNING id
          `.pipe(Effect.orDie);
          if (deleted.length === 0) return;
          yield* Effect.logInfo("A secret was deleted").pipe(Effect.annotateLogs({ secretId: id }));
          yield* changed;
        }),
      );

    const setAccess = (id: SecretId, access: SecretAccess) =>
      serialKnowing((known) =>
        Effect.gen(function* () {
          const { sql, key } = yield* ready;
          yield* secretById(sql, key, id, known);
          const checked = yield* checkedAccess(access, known);
          yield* transactional(sql)(
            Effect.gen(function* () {
              yield* writeAccess(sql, id, checked);
              yield* sql`
                UPDATE records SET updated_at = ${timeText(yield* DateTime.now)} WHERE id = ${id}
              `.pipe(Effect.orDie);
            }),
          );
          yield* Effect.logInfo("Which bots may use a secret changed").pipe(
            Effect.annotateLogs({ secretId: id, access: checked._tag }),
          );
          yield* changed;
          return yield* secretById(sql, key, id, known);
        }),
      );

    /** One sealed field of a secret, opened; `NotFound` for a secret without it. */
    const openedField = Effect.fn("Secrets.openedField")(function* (
      sql: SqlClient.SqlClient,
      key: Uint8Array,
      id: SecretId,
      field: SealedField,
    ) {
      const [row] = yield* fieldsOf(sql, [id], [field]);
      if (row === undefined) return yield* new NotFound({ resource: "secret" });
      return yield* openRow(key, row);
    });

    const totpOf = (id: SecretId, bytes: Buffer) =>
      readBack(id, "totp", Schema.decodeEffect(TotpJson)(text(bytes)));

    /** The field of a secret of `kind` that holds `field`; none for one it does not have. */
    const fieldOf = (kind: Secret["kind"]["_tag"], field: SecretField): SealedField | null =>
      kind === "value" ? (field === "value" ? "value" : null) : field === "value" ? null : field;

    const reveal = (input: {
      readonly id: SecretId;
      readonly field: SecretField;
      readonly deviceId: DeviceId;
    }) =>
      serialKnowing((known) =>
        Effect.gen(function* () {
          const { sql, key } = yield* ready;
          const secret = yield* secretById(sql, key, input.id, known);
          const sealed = fieldOf(secret.kind._tag, input.field);
          if (sealed === null) return yield* new NotFound({ resource: "secret" });
          const opened = yield* openedField(sql, key, input.id, sealed);
          const value = sealed === "totp" ? (yield* totpOf(input.id, opened)).secret : text(opened);
          yield* sql`
            INSERT INTO reveals (record_id, field, device_id, at)
            VALUES (${input.id}, ${input.field}, ${input.deviceId}, ${timeText(yield* DateTime.now)})
          `.pipe(Effect.orDie);
          yield* Effect.logInfo("A secret's value was shown").pipe(
            Effect.annotateLogs({
              secretId: input.id,
              field: input.field,
              deviceId: input.deviceId,
            }),
          );
          yield* changed;
          return Redacted.make(value);
        }),
      );

    /** The current code of a login's generator. */
    const codeNow = Effect.fn("Secrets.codeNow")(function* (id: SecretId, bytes: Buffer) {
      const config = yield* totpOf(id, bytes);
      const now = yield* DateTime.now;
      const code = totpAt(config, Math.floor(DateTime.toEpochMillis(now) / 1000));
      if (Option.isNone(code)) return yield* damaged(id, "totp");
      return code.value;
    });

    const totpPreview = (id: SecretId) =>
      serialKnowing((known) =>
        Effect.gen(function* () {
          const { sql, key } = yield* ready;
          yield* secretById(sql, key, id, known);
          const code = yield* codeNow(id, yield* openedField(sql, key, id, "totp"));
          return {
            code: Redacted.make(code.code),
            validUntil: DateTime.makeUnsafe(code.nextAt * 1000),
          };
        }),
      );

    // ---- Uses ---------------------------------------------------------------------

    /** When each secret's use was last written, for which bot and where. */
    const lastWritten = new Map<
      string,
      { readonly at: DateTime.Utc; readonly botId: BotId; readonly use: string }
    >();

    /**
     * Records that `botId` used the secret at `use`: once a minute at most for
     * the same bot and place, since a connector may send it with every call.
     */
    const noteUse = Effect.fn("Secrets.noteUse")(function* (
      sql: SqlClient.SqlClient,
      id: SecretId,
      botId: BotId,
      use: SecretUse,
    ) {
      const now = yield* DateTime.now;
      const where = yield* Schema.encodeEffect(UseJson)(use).pipe(
        Effect.catchTag("SchemaError", () => unencodable("where a secret was used")),
      );
      const last = lastWritten.get(id);
      if (
        last !== undefined &&
        last.botId === botId &&
        last.use === where &&
        Duration.isLessThan(DateTime.distance(last.at, now), USE_WRITTEN_EVERY)
      ) {
        return;
      }
      lastWritten.set(id, { at: now, botId, use: where });
      yield* sql`
        UPDATE records SET used_at = ${timeText(now)}, used_by = ${botId}, used_for = ${where}
        WHERE id = ${id}
      `.pipe(Effect.orDie);
      yield* changed;
    });

    const fillValue = (input: { readonly id: SecretId; readonly field: FillField }) =>
      serialKnowing((known) =>
        Effect.gen(function* () {
          const { sql, key } = yield* ready;
          const secret = yield* secretById(sql, key, input.id, known);
          if (secret.kind._tag !== "login") return yield* new NotFound({ resource: "secret" });
          const opened = yield* openedField(sql, key, input.id, input.field);
          let value: string;
          if (input.field === "totp") {
            value = (yield* codeNow(input.id, opened)).code;
          } else {
            value = text(opened);
            if (value === "") return yield* new NotFound({ resource: "secret" });
          }
          return { value: Redacted.make(value), secret };
        }),
      );

    const filled = (input: {
      readonly id: SecretId;
      readonly botId: BotId;
      readonly use: SecretUse;
    }) =>
      serial(
        Effect.gen(function* () {
          const { sql } = yield* ready;
          yield* noteUse(sql, input.id, input.botId, input.use);
        }),
      );

    /** One reference's value, for a connector `users` use. */
    const referenceValue = Effect.fn("Secrets.referenceValue")(function* (
      sql: SqlClient.SqlClient,
      key: Uint8Array,
      users: SecretAccess,
      reference: SecretReference,
      known: ReadonlySet<string>,
    ) {
      const unavailable = (reason: SecretUnavailable["reason"]) =>
        new SecretUnavailable({ secret: reference.name, reason });
      const id = yield* idNamed(sql, reference.name);
      if (Option.isNone(id)) return yield* unavailable("missing");
      const secret = yield* secretById(sql, key, id.value, known).pipe(
        Effect.mapError(() => unavailable("unavailable")),
      );
      if (!accessCovers(secret.access, users)) return yield* unavailable("not-allowed");
      const field: SealedField | null =
        secret.kind._tag === "value"
          ? reference.field === null
            ? "value"
            : null
          : (reference.field ?? "password");
      if (field === null) return yield* unavailable("no-value");
      const opened = yield* openedField(sql, key, secret.id, field).pipe(
        Effect.mapError((error) =>
          unavailable(error._tag === "NotFound" ? "no-value" : "unavailable"),
        ),
      );
      return Redacted.make(text(opened));
    });

    const referenceValues = (input: {
      readonly references: ReadonlyArray<SecretReference>;
      readonly users: SecretAccess;
    }) =>
      serialKnowing((known) =>
        Effect.gen(function* () {
          const values = new Map<string, Redacted.Redacted<string>>();
          const [first] = input.references;
          if (first === undefined) return values;
          const { sql, key } = yield* ready.pipe(
            Effect.mapError(
              () => new SecretUnavailable({ secret: first.name, reason: "unavailable" }),
            ),
          );
          for (const reference of input.references) {
            const found = referenceText(reference);
            if (values.has(found)) continue;
            values.set(found, yield* referenceValue(sql, key, input.users, reference, known));
          }
          return values;
        }),
      );

    const noteUses = (input: {
      readonly names: ReadonlyArray<SecretName>;
      readonly botId: BotId;
      readonly use: SecretUse;
    }) =>
      serial(
        Effect.gen(function* () {
          const { sql } = yield* ready;
          for (const name of new Set(input.names)) {
            const id = yield* idNamed(sql, name);
            if (Option.isSome(id)) yield* noteUse(sql, id.value, input.botId, input.use);
          }
        }),
      );

    // ---- Connectors' secrets ------------------------------------------------------

    const connectorSecret = (id: ConnectorId) =>
      serial(
        Effect.gen(function* () {
          const { sql, key } = yield* ready;
          const recordId = connectorRecordId(id);
          const rows = yield* fieldsOf(sql, [recordId], CONNECTOR_FIELDS);
          if (rows.length === 0) return Option.none<ConnectorSecret>();
          const opened = (field: (typeof CONNECTOR_FIELDS)[number]) => {
            const row = rows.find((candidate) => candidate.field === field);
            return row === undefined
              ? damaged(recordId, field)
              : Effect.map(openRow(key, row), text);
          };
          const address = yield* readBack(
            recordId,
            "address",
            Schema.decodeEffect(ConnectorAddressJson)(yield* opened("address")),
          );
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
          const command = yield* readBack(
            recordId,
            "command",
            Schema.decodeEffect(CommandJson)(yield* opened("command")),
          );
          const env = yield* readBack(
            recordId,
            "env",
            Schema.decodeEffect(NamedSecretsJson)(yield* opened("env")),
          );
          const formSecrets = yield* readBack(
            recordId,
            "formSecrets",
            Schema.decodeEffect(NamedSecretsJson)(yield* opened("formSecrets")),
          );
          return Option.some<ConnectorSecret>({
            connectorId: id,
            address,
            oauth,
            headers,
            command,
            env,
            formSecrets,
          });
        }),
      );

    const putConnectorSecret = (secret: ConnectorSecret) =>
      serial(
        Effect.gen(function* () {
          const { sql, key } = yield* ready;
          const recordId = connectorRecordId(secret.connectorId);
          const address = yield* Schema.encodeEffect(ConnectorAddressJson)(secret.address);
          const oauth = yield* Schema.encodeEffect(ConnectorOAuthJson)(secret.oauth);
          const headers = yield* Schema.encodeEffect(NamedSecretsJson)(secret.headers);
          const command = yield* Schema.encodeEffect(CommandJson)(secret.command);
          const env = yield* Schema.encodeEffect(NamedSecretsJson)(secret.env);
          const formSecrets = yield* Schema.encodeEffect(NamedSecretsJson)(secret.formSecrets);
          const rows = [
            yield* sealedRow(key, recordId, "address", utf8(address)),
            yield* sealedRow(key, recordId, "oauth", utf8(oauth)),
            yield* sealedRow(key, recordId, "headers", utf8(headers)),
            yield* sealedRow(key, recordId, "command", utf8(command)),
            yield* sealedRow(key, recordId, "env", utf8(env)),
            yield* sealedRow(key, recordId, "formSecrets", utf8(formSecrets)),
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
          const { sql } = yield* ready;
          yield* sql`DELETE FROM records WHERE id = ${connectorRecordId(id)}`.pipe(Effect.orDie);
        }),
      );

    return Secrets.of({
      status: SubscriptionRef.changes(state),
      openOldVault,
      list,
      usableBy,
      named,
      reveal,
      add,
      askedIn,
      update,
      remove,
      setAccess,
      totpPreview,
      fillValue,
      filled,
      referenceValues,
      noteUse: noteUses,
      connectorSecrets: {
        get: connectorSecret,
        put: putConnectorSecret,
        remove: removeConnectorSecret,
      },
    });
  }),
).pipe(Layer.provide(SecureRandom.layerWebCrypto));
