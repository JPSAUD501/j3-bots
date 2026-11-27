// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import { NONCE_BYTES, SALT_BYTES, sealField } from "../secrets/crypto.ts";
import Migration0001 from "../secrets/migrations/0001_initial.ts";
import { KEY_FILE, SECRETS_FILE } from "../secrets/store.ts";

/** Where the secrets' files are in the test's home. */
export const secretsFolder = Effect.gen(function* () {
  const { home } = yield* ServerConfig;
  return (yield* Path.Path).join(home, HOME_ENTRIES.secrets);
});

/**
 * Moves the secrets' key file away, so the server's next start cannot read
 * them, or back.
 */
export const moveKeyFile = (to: "away" | "back") =>
  Effect.gen(function* () {
    const key = (yield* Path.Path).join(yield* secretsFolder, KEY_FILE);
    const fs = yield* FileSystem.FileSystem;
    yield* to === "away" ? fs.rename(key, `${key}.away`) : fs.rename(`${key}.away`, key);
  }).pipe(Effect.orDie);

/** Runs `use` on the secrets' own database file, as something outside the server would. */
export const onSecretsFile = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const folder = yield* secretsFolder;
    const sql = yield* SqliteClient.make({
      filename: (yield* Path.Path).join(folder, SECRETS_FILE),
    });
    return yield* use(sql);
  }).pipe(Effect.scoped, Effect.provide(Reactivity.layer), Effect.orDie);

export const sealed = (key: Uint8Array, recordId: string, field: string, plain: string) => {
  const result = sealField(
    key,
    recordId,
    field,
    Buffer.from(plain, "utf8"),
    crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
  );
  return {
    nonce: Buffer.from(result.nonce).toString("base64"),
    sealed: Buffer.from(result.sealed).toString("base64"),
  };
};

/**
 * Writes a vault from before secrets into the test's home, as 0.8 left it:
 * its first migration only, a keyring, and a record for each of `ids`, each
 * with a sealed name. The keyring's wrapped key is random bytes: nothing
 * here opens it.
 */
export const oldVault = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const folder = yield* secretsFolder;
    yield* (yield* FileSystem.FileSystem).makeDirectory(folder, { recursive: true });
    const random = (size: number) =>
      Buffer.from(crypto.getRandomValues(new Uint8Array(size))).toString("base64");
    const now = "2026-10-01T09:00:00.000Z";
    yield* onSecretsFile((sql) =>
      Effect.gen(function* () {
        yield* SqliteMigrator.run({
          loader: SqliteMigrator.fromRecord({ "1_initial": Migration0001 }),
        }).pipe(
          Effect.provideService(SqliteClient.SqliteClient, sql),
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        yield* sql`
          INSERT INTO keyring (
            id, kdf, kdf_n, kdf_r, kdf_p, salt, key_nonce, wrapped_key, created_at, changed_at
          ) VALUES (
            1, 'scrypt', ${2 ** 14}, 1, 1, ${random(SALT_BYTES)}, ${random(NONCE_BYTES)},
            ${random(48)}, ${now}, ${now}
          )
        `;
        const dataKey = crypto.getRandomValues(new Uint8Array(32));
        for (const id of ids) {
          yield* sql`
            INSERT INTO records (id, kind, created_at, updated_at)
            VALUES (${id}, 'credential', ${now}, ${now})
          `;
          const row = sealed(dataKey, id, "name", "Example");
          yield* sql`
            INSERT INTO record_fields (record_id, field, nonce, sealed)
            VALUES (${id}, 'name', ${row.nonce}, ${row.sealed})
          `;
        }
      }),
    );
  });
