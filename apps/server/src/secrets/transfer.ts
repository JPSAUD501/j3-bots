// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Reactivity from "effect/reactivity/Reactivity";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Migrator from "effect/sql/Migrator";
import type * as SqlError from "effect/sql/SqlError";
import { replaceFileDurably } from "../files.ts";
import {
  KEY_BYTES,
  type KdfParams,
  kdfParamsInRange,
  NONCE_BYTES,
  openField,
  SALT_BYTES,
  sealField,
  withDerivedKey,
} from "./crypto.ts";
import {
  base64,
  bytesOf,
  KEY_FILE,
  keyFileText,
  keyOfText,
  newerThanThisRelease,
  opensKeyCheck,
  SECRETS_FILE,
  sealedOfText,
  sealKeyCheck,
  textOfSealed,
} from "./store.ts";

// The secrets on their way from one home to another (docs/architecture/server.md,
// "Moving to another server"). The key file never leaves its home. An export
// copies the secrets' database and seals every value in the copy again, under
// a key scrypt derives from a passphrase of the export's own, with a fresh
// salt; an import seals each again under the key of the home it lands in.
// Every value keeps its record id and field name as associated data, as
// `crypto.ts` binds it, so it opens nowhere else in the copy either. A value
// is open only between the two seals, and its bytes are zeroed then.

/** How an export derives its key from the passphrase: 128 MiB of scrypt. */
const EXPORT_KDF: KdfParams = { n: 2 ** 17, r: 8, p: 1 };

/** The shortest passphrase an export takes. */
export const PASSPHRASE_MIN_LENGTH = 8;

/** What a home's secrets are, for an export. */
export type SecretsAtHome =
  | { readonly _tag: "none" }
  | { readonly _tag: "left-out"; readonly reason: "old-vault" | "unreadable" | "newer" }
  | { readonly _tag: "ready"; readonly records: number };

/** The passphrase typed for the import is not the export's. */
class WrongPassphrase extends Schema.TaggedError<WrongPassphrase>()("WrongPassphrase", {}) {
  override get message(): string {
    return "That passphrase does not open the secrets in this export.";
  }
}

/** A sealed value that does not open: the file was changed or damaged. Never names a value. */
class SealedValueDamaged extends Schema.TaggedError<SealedValueDamaged>()("SealedValueDamaged", {
  where: Schema.Literals(["home", "export"]),
  recordId: Schema.String,
  field: Schema.String,
}) {
  override get message(): string {
    return this.where === "home"
      ? `A secret's sealed value does not open under this home's key (record ${this.recordId}, ${this.field}): the secrets were changed or damaged, so nothing was exported.`
      : `A secret's sealed value in the export does not open (record ${this.recordId}, ${this.field}): the export was changed or damaged, so nothing was imported.`;
  }
}

/** The export's key settings are not ones this release derives a key with. */
class ExportKdfRefused extends Schema.TaggedError<ExportKdfRefused>()("ExportKdfRefused", {}) {
  override get message(): string {
    return "The export's key settings are outside what J3 Bots takes, so its secrets were not opened.";
  }
}

const RecordFieldRow = Schema.Struct({
  record_id: Schema.String,
  field: Schema.String,
  nonce: Schema.String,
  sealed: Schema.String,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(RecordFieldRow));

const randomBuffer = Effect.fn("secrets.randomBuffer")(function* (size: number) {
  const bytes = yield* (yield* SecureRandom.SecureRandom).randomBytes(size);
  const copy = Buffer.alloc(size);
  copy.set(bytes);
  bytes.fill(0);
  return copy;
}, Effect.provide(SecureRandom.layerWebCrypto));

/** Opens the database at `file` for the scope. */
const openDatabase = (file: string) =>
  SqliteClient.make({ filename: file }).pipe(Effect.provide(Reactivity.layer));

const hasTable = (sql: SqlClient.SqlClient, table: string) =>
  Effect.map(
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
    (rows) => rows.length > 0,
  );

/** The key the key file in `folder` holds, if it holds one. */
const keyFileKey = Effect.fn("secrets.keyFileKey")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = (yield* Path.Path).join(folder, KEY_FILE);
  if (!(yield* fs.exists(file))) return Option.none<Buffer>();
  return keyOfText(yield* fs.readFileString(file));
});

/**
 * What the secrets in `folder` are, read without writing anything, with the
 * data key when they can be read. The caller holds the home, so no server
 * changes them meanwhile.
 */
const inspect = Effect.fn("secrets.inspect")(function* (
  folder: string,
): Effect.fn.Return<
  | Exclude<SecretsAtHome, { readonly _tag: "ready" }>
  | { readonly _tag: "ready"; readonly records: number; readonly key: Buffer },
  SqlError.SqlError | Migrator.MigrationError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const fs = yield* FileSystem.FileSystem;
  const file = (yield* Path.Path).join(folder, SECRETS_FILE);
  if (!(yield* fs.exists(file))) return { _tag: "none" };
  const sql = yield* openDatabase(file);
  if (yield* newerThanThisRelease(sql)) {
    return { _tag: "left-out", reason: "newer" };
  }
  if (!(yield* hasTable(sql, "records"))) return { _tag: "none" };
  const [counted] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM records`;
  const records = counted?.n ?? 0;
  if (records === 0) return { _tag: "none" };
  const keyring = yield* sql`SELECT 1 FROM keyring`;
  if (keyring.length > 0) {
    return { _tag: "left-out", reason: "old-vault" };
  }
  const unreadable = { _tag: "left-out", reason: "unreadable" } as const;
  if (!(yield* hasTable(sql, "key_check"))) return unreadable;
  const [check] = yield* sql<{ readonly nonce: string; readonly sealed: string }>`
    SELECT nonce, sealed FROM key_check WHERE id = 1
  `;
  const key = yield* keyFileKey(folder);
  if (check === undefined || Option.isNone(key) || !opensKeyCheck(key.value, check)) {
    if (Option.isSome(key)) key.value.fill(0);
    return unreadable;
  }
  return { _tag: "ready", records, key: key.value };
});

/** What the secrets in `folder` are, for an export: whether there are any, and whether they can be read. */
export const secretsAtHome = (folder: string) =>
  inspect(folder).pipe(
    Effect.map((found): SecretsAtHome => {
      if (found._tag !== "ready") return found;
      found.key.fill(0);
      return { _tag: "ready", records: found.records };
    }),
    Effect.scoped,
    Effect.orDie,
  );

/**
 * Every value in the secrets' database `sql`, opened under `from` and sealed
 * again under `to` with a fresh nonce, and the key check written for `to`, in
 * one transaction. An old vault's keyring goes with it: nothing in the copy
 * is sealed under a password any more.
 */
const resealAll = Effect.fn("secrets.resealAll")(function* (
  sql: SqlClient.SqlClient,
  from: Uint8Array,
  to: Uint8Array,
  where: "home" | "export",
) {
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* decodeRows(
        yield* sql`SELECT record_id, field, nonce, sealed FROM record_fields ORDER BY rowid`,
      ).pipe(Effect.orDie);
      for (const row of rows) {
        const plain = openField(from, row.record_id, row.field, sealedOfText(row));
        if (Option.isNone(plain)) {
          return yield* new SealedValueDamaged({
            where,
            recordId: row.record_id,
            field: row.field,
          });
        }
        const nonce = yield* randomBuffer(NONCE_BYTES);
        const sealed = textOfSealed(sealField(to, row.record_id, row.field, plain.value, nonce));
        plain.value.fill(0);
        yield* sql`
          UPDATE record_fields SET nonce = ${sealed.nonce}, sealed = ${sealed.sealed}
          WHERE record_id = ${row.record_id} AND field = ${row.field}
        `;
      }
      const check = sealKeyCheck(to, yield* randomBuffer(NONCE_BYTES));
      yield* sql`UPDATE key_check SET nonce = ${check.nonce}, sealed = ${check.sealed} WHERE id = 1`;
      yield* sql`DELETE FROM keyring`;
    }),
  );
  // What was overwritten leaves no page behind.
  yield* sql`VACUUM`;
});

/** The highest migration the secrets' database `sql` records. */
const lastMigrationOf = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{
      readonly last: number | null;
    }>`SELECT MAX(migration_id) AS last FROM effect_sql_migrations`,
    ([row]) => row?.last ?? 0,
  );

/** A copy's own settings: its journal stays in memory, and what it overwrites is zeroed. */
const asCopy = (sql: SqlClient.SqlClient) =>
  Effect.andThen(sql`PRAGMA journal_mode = MEMORY`, sql`PRAGMA secure_delete = ON`);

/**
 * Copies the secrets in `folder` to `destination`, a file that must not exist
 * yet, every value sealed again under the key `passphrase` gives with a fresh
 * salt, and answers how the key is derived. Asks for the passphrase, saying
 * how many secrets it seals, only when there is something to seal; secrets
 * that cannot be read are left out.
 */
export const exportSecrets = Effect.fn("secrets.exportSecrets")(
  function* <E, R>(
    folder: string,
    destination: string,
    passphrase: (records: number) => Effect.Effect<Redacted.Redacted<string>, E, R>,
  ) {
    const found = yield* inspect(folder);
    if (found._tag !== "ready") return found;
    const { key } = found;
    yield* Effect.addFinalizer(() => Effect.sync(() => key.fill(0)));
    const typed = yield* passphrase(found.records);
    const source = yield* openDatabase((yield* Path.Path).join(folder, SECRETS_FILE));
    yield* source`VACUUM INTO ${destination}`;
    const copy = yield* openDatabase(destination);
    yield* asCopy(copy);
    const salt = yield* randomBuffer(SALT_BYTES);
    yield* withDerivedKey(typed, salt, EXPORT_KDF, (exportKey) =>
      resealAll(copy, key, exportKey, "home"),
    );
    return {
      _tag: "sealed" as const,
      records: found.records,
      lastMigration: yield* lastMigrationOf(copy),
      kdf: { algorithm: "scrypt" as const, ...EXPORT_KDF, salt: base64(salt) },
    };
  },
  Effect.scoped,
  Effect.catchTag("SqlError", Effect.die),
);

/**
 * The key an import seals its secrets under, for the home whose secrets are
 * in `folder`: its key file's, or a new one, written to `newKeyFile` and
 * flushed to the disk, for the import to put in place with the secrets.
 */
export const importKey = Effect.fn("secrets.importKey")(function* (
  folder: string,
  newKeyFile: string,
) {
  const stored = yield* keyFileKey(folder);
  if (Option.isSome(stored)) return stored.value;
  const key = yield* randomBuffer(KEY_BYTES);
  yield* replaceFileDurably(newKeyFile, keyFileText(key), 0o600);
  return key;
});

/**
 * Seals every value of the export's copy of the secrets at `copy` again,
 * from the key `passphrase` gives with `kdf` to `key`, in place. A wrong
 * passphrase changes nothing.
 */
export const importSecrets = Effect.fn("secrets.importSecrets")(
  function* (
    copy: string,
    kdf: { readonly n: number; readonly r: number; readonly p: number; readonly salt: string },
    passphrase: Redacted.Redacted<string>,
    key: Uint8Array,
  ) {
    const params = { n: kdf.n, r: kdf.r, p: kdf.p };
    if (!kdfParamsInRange(params)) return yield* new ExportKdfRefused();
    const sql = yield* openDatabase(copy);
    yield* asCopy(sql);
    const [check] = yield* sql<{ readonly nonce: string; readonly sealed: string }>`
      SELECT nonce, sealed FROM key_check WHERE id = 1
    `;
    yield* withDerivedKey(passphrase, bytesOf(kdf.salt), params, (exportKey) =>
      Effect.gen(function* () {
        if (check === undefined || !opensKeyCheck(exportKey, check)) {
          return yield* new WrongPassphrase();
        }
        yield* resealAll(sql, exportKey, key, "export");
      }),
    );
  },
  Effect.scoped,
  Effect.catchTag("SqlError", Effect.die),
);
