// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The vault becomes secrets (decision 0046): the server keeps the data key in
// a key file of its own, beside this database, and no master password opens
// anything any more.
//
// - A record is a `login`, a `value` or a `connector`: `credential` becomes
//   `login`. SQLite cannot change a check, so the column is replaced in place,
//   as the main database's migrations do with `entries.kind`.
// - A secret's name is in the clear, unique among the operator's secrets,
//   since a reference finds the secret by it. A login of a vault sealed under
//   a master password keeps its name sealed until that password is typed one
//   last time, when the server gives it a name: until then the column is
//   null, and nothing reads the record.
// - `every_bot`: every bot may use it, the ones made later included; the
//   bots of `record_bots` otherwise.
// - `used_at`, `used_by` and `used_for`: the last time a bot used it, which
//   bot, and where (a `SecretUse` as JSON).
// - `key_check`: a value sealed under the data key, which tells the key file's
//   key from another one. No row: nothing was ever sealed under a key file's
//   key.
// - `keyring` stays only for a vault from before, until its password opens
//   it; `unlock_failures` goes, with the wait after wrong passwords.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE records ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'login' CHECK (
      record_kind IN ('login', 'value', 'connector')
    )
  `;
  yield* sql`
    UPDATE records SET record_kind = CASE kind WHEN 'credential' THEN 'login' ELSE kind END
  `;
  yield* sql`ALTER TABLE records DROP COLUMN kind`;
  yield* sql`ALTER TABLE records RENAME COLUMN record_kind TO kind`;

  yield* sql`ALTER TABLE records ADD COLUMN name TEXT`;
  yield* sql`
    CREATE UNIQUE INDEX records_name ON records (name) WHERE name IS NOT NULL
  `;
  yield* sql`
    ALTER TABLE records ADD COLUMN every_bot INTEGER NOT NULL DEFAULT 0 CHECK (
      every_bot IN (0, 1)
    )
  `;
  yield* sql`ALTER TABLE records ADD COLUMN used_at TEXT`;
  yield* sql`ALTER TABLE records ADD COLUMN used_by TEXT`;
  yield* sql`ALTER TABLE records ADD COLUMN used_for TEXT`;

  yield* sql`
    CREATE TABLE key_check (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      nonce TEXT NOT NULL,
      sealed TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`DROP TABLE unlock_failures`;
});
