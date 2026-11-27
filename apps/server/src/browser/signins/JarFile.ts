// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import { BrowserCookie, BrowserOriginStorage } from "@j3-bots/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { json } from "../../persistence/columns.ts";
import { migrate } from "../../persistence/Migrations.ts";
import { transactional } from "../../persistence/transaction.ts";
import { NONCE_BYTES, openField, sealField } from "../../secrets/crypto.ts";
import { sealedOfText, textOfSealed } from "../../secrets/store.ts";
import { type Digest, isEmptyStorage } from "./canonical.ts";
import type { JarCookieChanges, JarOrigin } from "./merge.ts";
import Migration0001 from "./migrations/0001_initial.ts";

// The sign-ins' file (`docs/architecture/server.md`, "Sign-ins"): opened
// once at start, every row opened into memory then, and each change written
// through in one transaction. A file that does not open under the key, a row
// that does not, or one a newer release migrated, leaves the jar
// `unreadable`: nothing is synced from it or to it until the person signs
// out of all sites, which starts it again, empty.

/** The sign-ins' file, in the home's `browser` folder. */
export const SIGNINS_FILE = "signins.sqlite";

const migrations = SqliteMigrator.fromRecord({ "1_initial": Migration0001 });

/** How long a removed cookie's tombstone, and an emptied origin, are kept. */
const KEPT_REMOVED_MS = 30 * 24 * 60 * 60 * 1000;
/** How long the baseline of a store that never comes back is kept. */
const KEPT_STORE_MS = 90 * 24 * 60 * 60 * 1000;

const KEY_CHECK_ID = "key-check";
const KEY_CHECK_TEXT = "j3-bots browser sign-ins";

const decodeCookie = Schema.decodeUnknownOption(json(BrowserCookie));
const encodeCookie = Schema.encodeEffect(json(BrowserCookie));
const SealedOrigin = Schema.Struct({ storage: BrowserOriginStorage, indexedDb: Schema.Boolean });
const decodeOrigin = Schema.decodeUnknownOption(json(SealedOrigin));
const encodeOrigin = Schema.encodeEffect(json(SealedOrigin));

const MetaRow = Schema.Struct({
  version: Schema.Int,
  check_nonce: Schema.String,
  check_sealed: Schema.String,
  migrated_at: Schema.NullOr(Schema.Int),
});
const SealedRow = Schema.Struct({ id: Schema.String, nonce: Schema.String, sealed: Schema.String });
const TombstoneRow = Schema.Struct({ id: Schema.String, digest: Schema.String });
const SignoutRow = Schema.Struct({ id: Schema.String, version: Schema.Int });
const StoreRow = Schema.Struct({ version: Schema.Int });
const EntryRow = Schema.Struct({
  kind: Schema.Literals(["cookie", "origin"]),
  id: Schema.String,
  digest: Schema.String,
});

/** What the jar holds, opened: the sign-ins keep it in memory. */
export interface JarContents {
  readonly version: number;
  readonly cookies: Map<Digest, BrowserCookie>;
  /** The digest of the value each removed cookie had. */
  readonly tombstones: Map<Digest, Digest>;
  readonly origins: Map<Digest, JarOrigin>;
  /** The version each site, or every site, was signed out of at. */
  readonly signouts: Map<Digest, number>;
  /** Whether the sign-ins of before 0.16 were brought in. */
  readonly migrated: boolean;
}

/** A host store's baseline: the version it agreed at, and what it held. */
export interface StoreBaseline {
  readonly version: number;
  readonly cookies: Map<Digest, Digest>;
  readonly origins: Map<Digest, Digest>;
}

/** A change to one store's baseline: `replace` writes it whole. */
interface StoreCommit {
  readonly id: Digest;
  readonly version: number;
  readonly replace: boolean;
  /** Entries set, or removed (undefined). */
  readonly cookies: ReadonlyMap<Digest, Digest | undefined>;
  readonly origins: ReadonlyMap<Digest, Digest | undefined>;
}

/** One change to the jar, written whole or not at all. */
export interface JarCommit {
  readonly version: number;
  readonly cookies?: JarCookieChanges;
  readonly origins?: ReadonlyArray<readonly [Digest, JarOrigin]>;
  readonly signouts?: ReadonlyArray<readonly [Digest, number]>;
  readonly stores?: ReadonlyArray<StoreCommit>;
  readonly droppedStores?: ReadonlyArray<Digest>;
  readonly migrated?: boolean;
}

export interface JarFile {
  /** The baseline of store `id`, if it has one. */
  readonly baseline: (id: Digest) => Effect.Effect<Option.Option<StoreBaseline>>;
  readonly commit: (change: JarCommit) => Effect.Effect<void>;
  /** Empties the jar, for "Sign out of all sites" on a jar that is unreadable or not. */
  readonly reset: Effect.Effect<void>;
}

/** The jar as it opened. */
export type OpenedJar =
  | { readonly _tag: "open"; readonly file: JarFile; readonly contents: JarContents }
  | { readonly _tag: "unreadable"; readonly file: JarFile };

/**
 * Opens the sign-ins' file at `location`, sealed under `key`, for as long as
 * the scope lives. A file without a key check is new, and gets one.
 */
export const openJarFile = Effect.fn("SignIns.openJarFile")(function* (
  location: string,
  key: Uint8Array,
) {
  const sql = yield* SqliteClient.make({ filename: location }).pipe(
    Effect.provide(Reactivity.layer),
    Effect.orDie,
  );
  yield* sql`PRAGMA foreign_keys = ON`.pipe(Effect.orDie);
  yield* sql`PRAGMA secure_delete = ON`.pipe(Effect.orDie);
  yield* sql`PRAGMA journal_mode = WAL`.pipe(Effect.orDie);
  const random = yield* SecureRandom.SecureRandom;
  const inTransaction = transactional(sql);

  const nonce = Effect.map(random.randomBytes(NONCE_BYTES), (bytes) => Buffer.from(bytes));
  const seal = (id: string, field: string, text: string) =>
    Effect.map(nonce, (fresh) =>
      textOfSealed(sealField(key, id, field, Buffer.from(text, "utf8"), fresh)),
    );
  const open = (
    id: string,
    field: string,
    row: { readonly nonce: string; readonly sealed: string },
  ) =>
    Option.map(openField(key, id, field, sealedOfText(row)), (plain) => {
      const text = plain.toString("utf8");
      plain.fill(0);
      return text;
    });

  const writeKeyCheck = Effect.gen(function* () {
    const check = yield* seal(KEY_CHECK_ID, "key", KEY_CHECK_TEXT);
    yield* sql`
      INSERT INTO meta (id, version, check_nonce, check_sealed)
      VALUES (1, 0, ${check.nonce}, ${check.sealed})
    `;
  });

  const migrateFile = migrate(migrations).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const migrated = yield* migrateFile.pipe(
    Effect.as(true),
    Effect.catchTag("MigrationError", (error) =>
      Effect.logWarning("The browser's sign-ins were written by a newer release").pipe(
        Effect.annotateLogs({ detail: error.message }),
        Effect.as(false),
      ),
    ),
    Effect.orDie,
  );

  /**
   * Empties the file, whatever release wrote it: every table goes, the
   * latest created first, and the file is made again under `key`.
   */
  const reset = Effect.gen(function* () {
    yield* inTransaction(
      Effect.gen(function* () {
        const tables = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: Schema.Struct({ name: Schema.String }),
          execute: () => sql`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid DESC
          `,
        })(undefined);
        for (const { name } of tables) yield* sql`DROP TABLE ${sql(name)}`;
      }),
    );
    yield* migrateFile;
    yield* inTransaction(writeKeyCheck);
  }).pipe(Effect.orDie);

  const baseline = Effect.fn("SignIns.baseline")(function* (id: Digest) {
    const store = yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: StoreRow,
      execute: () => sql`SELECT version FROM stores WHERE id = ${id}`,
    })(undefined);
    if (Option.isNone(store)) return Option.none<StoreBaseline>();
    const entries = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: EntryRow,
      execute: () => sql`SELECT kind, id, digest FROM store_entries WHERE store = ${id}`,
    })(undefined);
    const cookies = new Map<Digest, Digest>();
    const origins = new Map<Digest, Digest>();
    for (const entry of entries)
      (entry.kind === "cookie" ? cookies : origins).set(entry.id, entry.digest);
    return Option.some({ version: store.value.version, cookies, origins });
  }, Effect.orDie);

  const writeEntries = (
    store: Digest,
    kind: "cookie" | "origin",
    entries: ReadonlyMap<Digest, Digest | undefined>,
  ) =>
    Effect.forEach(
      entries,
      ([id, digest]) =>
        digest === undefined
          ? sql`DELETE FROM store_entries WHERE store = ${store} AND kind = ${kind} AND id = ${id}`
          : sql`
              INSERT INTO store_entries (store, kind, id, digest)
              VALUES (${store}, ${kind}, ${id}, ${digest})
              ON CONFLICT (store, kind, id) DO UPDATE SET digest = excluded.digest
            `,
      { discard: true },
    );

  const commit = (change: JarCommit) =>
    inTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE meta SET version = ${change.version} WHERE id = 1`;
        if (change.migrated === true) yield* sql`UPDATE meta SET migrated_at = ${now} WHERE id = 1`;
        for (const [id, cookie] of change.cookies?.set ?? []) {
          const sealed = yield* seal(id, "cookie", yield* encodeCookie(cookie));
          yield* sql`
            INSERT INTO cookies (id, nonce, sealed) VALUES (${id}, ${sealed.nonce}, ${sealed.sealed})
            ON CONFLICT (id) DO UPDATE SET nonce = excluded.nonce, sealed = excluded.sealed
          `;
          yield* sql`DELETE FROM tombstones WHERE id = ${id}`;
        }
        for (const [id, digest] of change.cookies?.removed ?? []) {
          yield* sql`DELETE FROM cookies WHERE id = ${id}`;
          yield* sql`
            INSERT INTO tombstones (id, digest, removed_at) VALUES (${id}, ${digest}, ${now})
            ON CONFLICT (id) DO UPDATE SET digest = excluded.digest, removed_at = excluded.removed_at
          `;
        }
        for (const [id, origin] of change.origins ?? []) {
          const sealed = yield* seal(id, "origin", yield* encodeOrigin(origin));
          const emptied = isEmptyStorage(origin.storage) ? now : null;
          yield* sql`
            INSERT INTO origins (id, nonce, sealed, emptied_at)
            VALUES (${id}, ${sealed.nonce}, ${sealed.sealed}, ${emptied})
            ON CONFLICT (id) DO UPDATE SET
              nonce = excluded.nonce, sealed = excluded.sealed, emptied_at = excluded.emptied_at
          `;
        }
        for (const [id, version] of change.signouts ?? [])
          yield* sql`
            INSERT INTO signouts (id, version) VALUES (${id}, ${version})
            ON CONFLICT (id) DO UPDATE SET version = excluded.version
          `;
        for (const id of change.droppedStores ?? [])
          yield* sql`DELETE FROM stores WHERE id = ${id}`;
        for (const store of change.stores ?? []) {
          yield* sql`
            INSERT INTO stores (id, version, seen_at) VALUES (${store.id}, ${store.version}, ${now})
            ON CONFLICT (id) DO UPDATE SET version = excluded.version, seen_at = excluded.seen_at
          `;
          if (store.replace) yield* sql`DELETE FROM store_entries WHERE store = ${store.id}`;
          yield* writeEntries(store.id, "cookie", store.cookies);
          yield* writeEntries(store.id, "origin", store.origins);
        }
      }),
    ).pipe(Effect.orDie);

  const file: JarFile = { baseline, commit, reset };
  if (!migrated) return { _tag: "unreadable", file } as const satisfies OpenedJar;

  /** What is old enough to go: tombstones, emptied origins, stores not seen for long. */
  const prune = inTransaction(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`DELETE FROM tombstones WHERE removed_at < ${now - KEPT_REMOVED_MS}`;
      yield* sql`DELETE FROM origins WHERE emptied_at < ${now - KEPT_REMOVED_MS}`;
      yield* sql`DELETE FROM stores WHERE seen_at < ${now - KEPT_STORE_MS}`;
    }),
  ).pipe(Effect.orDie);

  const load = Effect.gen(function* () {
    const meta = yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: MetaRow,
      execute: () =>
        sql`SELECT version, check_nonce, check_sealed, migrated_at FROM meta WHERE id = 1`,
    })(undefined).pipe(Effect.orDie);
    if (Option.isNone(meta)) {
      yield* inTransaction(writeKeyCheck).pipe(Effect.orDie);
      return Option.some<JarContents>({
        version: 0,
        cookies: new Map(),
        tombstones: new Map(),
        origins: new Map(),
        signouts: new Map(),
        migrated: false,
      });
    }
    const check = open(KEY_CHECK_ID, "key", {
      nonce: meta.value.check_nonce,
      sealed: meta.value.check_sealed,
    });
    if (Option.getOrNull(check) !== KEY_CHECK_TEXT) return Option.none<JarContents>();
    yield* prune;
    const cookieRows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: SealedRow,
      execute: () => sql`SELECT id, nonce, sealed FROM cookies`,
    })(undefined).pipe(Effect.orDie);
    const cookies = new Map<Digest, BrowserCookie>();
    for (const row of cookieRows) {
      const cookie = Option.flatMap(open(row.id, "cookie", row), decodeCookie);
      if (Option.isNone(cookie)) return Option.none<JarContents>();
      cookies.set(row.id, cookie.value);
    }
    const originRows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: SealedRow,
      execute: () => sql`SELECT id, nonce, sealed FROM origins`,
    })(undefined).pipe(Effect.orDie);
    const origins = new Map<Digest, JarOrigin>();
    for (const row of originRows) {
      const origin = Option.flatMap(open(row.id, "origin", row), decodeOrigin);
      if (Option.isNone(origin)) return Option.none<JarContents>();
      origins.set(row.id, origin.value);
    }
    const tombstones = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: TombstoneRow,
      execute: () => sql`SELECT id, digest FROM tombstones`,
    })(undefined).pipe(Effect.orDie);
    const signouts = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: SignoutRow,
      execute: () => sql`SELECT id, version FROM signouts`,
    })(undefined).pipe(Effect.orDie);
    return Option.some<JarContents>({
      version: meta.value.version,
      cookies,
      tombstones: new Map(tombstones.map(({ id, digest }) => [id, digest])),
      origins,
      signouts: new Map(signouts.map(({ id, version }) => [id, version])),
      migrated: meta.value.migrated_at !== null,
    });
  });

  const contents = yield* load;
  if (Option.isNone(contents)) {
    yield* Effect.logError(
      "The browser's sign-ins do not open under the secrets' key: nothing is synced until the person signs out of all sites",
    );
    return { _tag: "unreadable", file } as const satisfies OpenedJar;
  }
  return { _tag: "open", file, contents: contents.value } as const satisfies OpenedJar;
});
