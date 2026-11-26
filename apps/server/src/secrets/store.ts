// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { migrate } from "../persistence/Migrations.ts";
import { KEY_BYTES, openField, type Sealed, sealField } from "./crypto.ts";
import Migration0001 from "./migrations/0001_initial.ts";
import Migration0002 from "./migrations/0002_secrets.ts";

// The secrets' files as they are on the disk (docs/architecture/server.md,
// "Secrets"): their database and its migrations, the key file and the key
// check. The server (`Secrets.ts`) and a home's export and import
// (`transfer.ts`) read them the same way.

/** The secrets' file, inside their own folder of the home. */
export const SECRETS_FILE = "vault.sqlite";

/** The key file beside it: the data key every value is sealed under. */
export const KEY_FILE = "key";

/** The secrets' migrations, forward only, like the database's (`persistence/Migrations.ts`). */
export const migrations = SqliteMigrator.fromRecord({
  "1_initial": Migration0001,
  "2_secrets": Migration0002,
});

/** The first line of the key file, which says what the second holds. */
const KEY_FILE_HEADER = "j3-bots secrets key v1";

/** The record and field the key check is sealed for: no record has that id. */
const KEY_CHECK_RECORD = "key-check";
const KEY_CHECK_FIELD = "key";
const KEY_CHECK_TEXT = "j3-bots secrets";

/** Bytes as the file keeps them: base64. */
export const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
export const bytesOf = (text: string) => Buffer.from(text, "base64");

/** A sealed value as the file keeps it, in a row's `nonce` and `sealed`. */
export interface SealedText {
  readonly nonce: string;
  readonly sealed: string;
}

export const sealedOfText = (row: SealedText): Sealed => ({
  nonce: bytesOf(row.nonce),
  sealed: bytesOf(row.sealed),
});

export const textOfSealed = (value: Sealed): SealedText => ({
  nonce: base64(value.nonce),
  sealed: base64(value.sealed),
});

/** The key file's text for `key`. */
export const keyFileText = (key: Uint8Array) => `${KEY_FILE_HEADER}\n${base64(key)}\n`;

/** The key a key file's text holds; none when it is not one. */
export const keyOfText = (text: string): Option.Option<Buffer> => {
  const [header, encoded] = text.split("\n");
  if (header !== KEY_FILE_HEADER || encoded === undefined) return Option.none();
  const key = bytesOf(encoded);
  if (key.length === KEY_BYTES) return Option.some(key);
  key.fill(0);
  return Option.none();
};

/** Whether `key` is the one the key check was sealed under. */
export const opensKeyCheck = (key: Uint8Array, check: SealedText) =>
  Option.match(openField(key, KEY_CHECK_RECORD, KEY_CHECK_FIELD, sealedOfText(check)), {
    onNone: () => false,
    onSome: (plain) => {
      const right = plain.toString("utf8") === KEY_CHECK_TEXT;
      plain.fill(0);
      return right;
    },
  });

/** The key check for `key`, sealed under `nonce`. */
export const sealKeyCheck = (key: Uint8Array, nonce: Uint8Array): SealedText =>
  textOfSealed(
    sealField(key, KEY_CHECK_RECORD, KEY_CHECK_FIELD, Buffer.from(KEY_CHECK_TEXT, "utf8"), nonce),
  );

/** Whether the database `sql` records a migration of the secrets this release does not know. */
export const newerThanThisRelease = Effect.fn("secrets.newerThanThisRelease")(function* (
  sql: SqlClient.SqlClient,
) {
  const [table] = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (table === undefined) return false;
  const known = new Set((yield* migrations).map(([id]) => id));
  const recorded = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM effect_sql_migrations
  `;
  return recorded.some(({ migration_id }) => !known.has(migration_id));
});

/** The secrets' database, open and migrated, or left alone because a newer release wrote it. */
export type SecretsFile =
  | { readonly _tag: "open"; readonly sql: SqlClient.SqlClient }
  | { readonly _tag: "newer" };

/**
 * Opens the secrets' database at `location`, migrated. One that records a
 * migration this release does not know is left as it is: the release that
 * wrote it can still read it, so it is refused here without stopping the
 * server.
 */
export const openSecretsFile = Effect.fn("Secrets.open")(function* (location: string) {
  const sql = yield* SqliteClient.make({ filename: location });
  yield* sql`PRAGMA foreign_keys = ON`;
  // What is deleted is overwritten, not only unlinked: a deleted value, or an
  // old vault's keyring, never stays readable in the file's free space.
  yield* sql`PRAGMA secure_delete = ON`;
  if (yield* newerThanThisRelease(sql)) {
    yield* Effect.logWarning(
      "A newer release of J3 Bots changed the secrets, which this one cannot read; they stay as they are",
    );
    return { _tag: "newer" } as const satisfies SecretsFile;
  }
  yield* migrate(migrations).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  return { _tag: "open", sql } as const satisfies SecretsFile;
});
