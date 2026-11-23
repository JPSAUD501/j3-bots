// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The vault's own database, `<home>/vault/vault.sqlite`. It is not one of the
// files an update's snapshot copies, so it has migrations of its own, which a
// rollback never undoes.
//
// Every value is sealed (`vault/crypto.ts`): a record's fields hold a nonce
// and the ciphertext with its tag, never the plain value. What stays in the
// clear is what the server needs without the key: which records exist and of
// what kind, when they changed, which bots may use them and when a value was
// shown, on which device.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The one keyring: scrypt's salt and parameters, and the data key wrapped
  // by the key the master password gives. No row: no password was ever set.
  yield* sql`
    CREATE TABLE keyring (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      kdf TEXT NOT NULL CHECK (kdf = 'scrypt'),
      kdf_n INTEGER NOT NULL CHECK (kdf_n > 1),
      kdf_r INTEGER NOT NULL CHECK (kdf_r > 0),
      kdf_p INTEGER NOT NULL CHECK (kdf_p > 0),
      salt TEXT NOT NULL,
      key_nonce TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      changed_at TEXT NOT NULL
    )
  `;

  // A record of any kind the vault keeps: a login, or what a connector needs
  // to reach its server. Another kind adds itself to the check and names the
  // fields it seals.
  yield* sql`
    CREATE TABLE records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('credential', 'connector')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // A record's sealed fields, base64: one value each, bound to its record and
  // field as associated data.
  yield* sql`
    CREATE TABLE record_fields (
      record_id TEXT NOT NULL REFERENCES records (id) ON DELETE CASCADE,
      field TEXT NOT NULL,
      nonce TEXT NOT NULL,
      sealed TEXT NOT NULL,
      PRIMARY KEY (record_id, field)
    )
  `;

  // The bots a login is allowed to. A bot's id outlives the bot, and the
  // bots live in the other database, so it has no foreign key.
  yield* sql`
    CREATE TABLE record_bots (
      record_id TEXT NOT NULL REFERENCES records (id) ON DELETE CASCADE,
      bot_id TEXT NOT NULL,
      PRIMARY KEY (record_id, bot_id)
    )
  `;

  // Each time a value was shown to the operator: when, which value and on
  // which device. Never the value.
  yield* sql`
    CREATE TABLE reveals (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL REFERENCES records (id) ON DELETE CASCADE,
      field TEXT NOT NULL,
      device_id TEXT NOT NULL,
      at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX reveals_record ON reveals (record_id, seq)`;
});
