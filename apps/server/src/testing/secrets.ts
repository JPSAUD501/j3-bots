// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import type { BotId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { HOME_ENTRIES } from "../home/entries.ts";
import {
  LEAST_KDF_PARAMS,
  NONCE_BYTES,
  SALT_BYTES,
  sealField,
  withDerivedKey,
  wrapDataKey,
} from "../secrets/crypto.ts";
import Migration0001 from "../secrets/migrations/0001_initial.ts";
import { KEY_FILE, SECRETS_FILE } from "../secrets/store.ts";

/** The master password of the vault `oldVault` writes. */
export const OLD_VAULT_PASSWORD = Redacted.make("correct horse battery");

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

/** A login of a vault from before secrets, as it sealed one: its name sealed with its values. */
export interface OldLogin {
  readonly id: string;
  readonly label: string;
  readonly password: string;
  readonly bots: ReadonlyArray<BotId>;
}

/**
 * Writes a vault from before secrets into the test's home, as 0.8 left it:
 * its first migration only, a data key wrapped under `OLD_VAULT_PASSWORD` at the
 * cheapest key settings, and `logins` sealed under that key.
 */
export const oldVault = (logins: ReadonlyArray<OldLogin>) =>
  Effect.gen(function* () {
    const folder = yield* secretsFolder;
    yield* (yield* FileSystem.FileSystem).makeDirectory(folder, { recursive: true });
    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const wrapped = yield* withDerivedKey(
      OLD_VAULT_PASSWORD,
      Buffer.from(salt),
      LEAST_KDF_PARAMS,
      (kek) =>
        Effect.succeed(
          wrapDataKey(kek, dataKey, crypto.getRandomValues(new Uint8Array(NONCE_BYTES))),
        ),
    );
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
            1, 'scrypt', ${LEAST_KDF_PARAMS.n}, ${LEAST_KDF_PARAMS.r}, ${LEAST_KDF_PARAMS.p},
            ${Buffer.from(salt).toString("base64")},
            ${Buffer.from(wrapped.nonce).toString("base64")},
            ${Buffer.from(wrapped.sealed).toString("base64")}, ${now}, ${now}
          )
        `;
        for (const entry of logins) {
          yield* sql`
            INSERT INTO records (id, kind, created_at, updated_at)
            VALUES (${entry.id}, 'credential', ${now}, ${now})
          `;
          const fields = {
            name: entry.label,
            origins: `["https://example.com"]`,
            username: "ana@example.com",
            password: entry.password,
          };
          for (const [field, plain] of Object.entries(fields)) {
            const row = sealed(dataKey, entry.id, field, plain);
            yield* sql`
              INSERT INTO record_fields (record_id, field, nonce, sealed)
              VALUES (${entry.id}, ${field}, ${row.nonce}, ${row.sealed})
            `;
          }
          for (const botId of entry.bots) {
            yield* sql`INSERT INTO record_bots (record_id, bot_id) VALUES (${entry.id}, ${botId})`;
          }
        }
      }),
    );
    /** The keyring's wrapped key as the file holds it. */
    return { wrappedKey: Buffer.from(wrapped.sealed).toString("base64") };
  });
