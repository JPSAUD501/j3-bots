// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The shared sign-ins of J3 Bots' browser (decision 0110), in a file of
// their own beside nothing else: no update copies it, no export carries it.
// Every name is an HMAC under the sign-ins' key, and every value is sealed
// under it, bound to its row's id (`docs/architecture/server.md`,
// "Sign-ins").
//
// - `meta`: the jar's one row: its version, which moves on every change, the
//   key check, and when the browser's sign-ins of before 0.16 were brought in.
// - `cookies`, `origins`: a cookie by its key, an origin's storage by the
//   origin. An origin signed out of stays, emptied, until `emptied_at` is old.
// - `tombstones`: a cookie the jar removed and the digest of its value, so a
//   host new to the jar does not bring it back.
// - `signouts`: a site the person signed out of, or every site (`*`), and
//   the version that did, which wins over what a host changed before it
//   connected again.
// - `stores`, `store_entries`: a host's store (its `cookieStore`), the
//   version it last agreed with the jar at, and what it held then.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL CHECK (version >= 0),
      check_nonce TEXT NOT NULL,
      check_sealed TEXT NOT NULL,
      migrated_at INTEGER
    )
  `;
  yield* sql`
    CREATE TABLE cookies (
      id TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      sealed TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE origins (
      id TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      sealed TEXT NOT NULL,
      emptied_at INTEGER
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE tombstones (
      id TEXT PRIMARY KEY,
      digest TEXT NOT NULL,
      removed_at INTEGER NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE signouts (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE stores (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      seen_at INTEGER NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE store_entries (
      store TEXT NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('cookie', 'origin')),
      id TEXT NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (store, kind, id)
    ) WITHOUT ROWID
  `;
});
