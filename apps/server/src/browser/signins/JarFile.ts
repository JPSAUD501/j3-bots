// SPDX-License-Identifier: AGPL-3.0-or-later
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import { BrowserCookie, BrowserOriginStorage, BrowserSite } from "@j3-bots/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
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
// through in one transaction. A file that does not open, does not open under
// the key, holds a row that does not, or that a newer release migrated,
// leaves the jar `unreadable`: nothing is synced from it or to it until the
// person signs out of all sites, which deletes the file and starts it again,
// empty. Start goes on either way.

/** The sign-ins' file, in the home's `browser` folder. */
export const SIGNINS_FILE = "signins.sqlite";

/** The files SQLite keeps beside the database: what a reset deletes with it. */
const BESIDE = ["-wal", "-shm", "-journal"] as const;

const migrations = SqliteMigrator.fromRecord({ "1_initial": Migration0001 });

/**
 * How long a removed cookie's tombstone, an emptied origin, and the baseline
 * of a store that does not come back are kept: as long as one another, so a
 * store that comes back within it finds what it needs, and one that comes
 * back after it is new to the jar.
 */
export const KEPT_MS = 90 * 24 * 60 * 60 * 1000;

const KEY_CHECK_ID = "key-check";
const KEY_CHECK_TEXT = "j3-bots browser sign-ins";

const decodeCookie = Schema.decodeUnknownOption(json(BrowserCookie));
const encodeCookie = Schema.encodeEffect(json(BrowserCookie));
const SealedOrigin = Schema.Struct({
  storage: BrowserOriginStorage,
  tooBig: Schema.optionalKey(Schema.Literal(true)),
});
const decodeOrigin = Schema.decodeUnknownOption(json(SealedOrigin));
const encodeOrigin = Schema.encodeEffect(json(SealedOrigin));
const decodeSite = Schema.decodeUnknownOption(BrowserSite);

const MetaRow = Schema.Struct({
  version: Schema.Int,
  check_nonce: Schema.String,
  check_sealed: Schema.String,
  migrated_at: Schema.NullOr(Schema.Int),
  cleared_at: Schema.NullOr(Schema.Int),
});
const SealedRow = Schema.Struct({ id: Schema.String, nonce: Schema.String, sealed: Schema.String });
const TombstoneRow = Schema.Struct({ id: Schema.String, digest: Schema.String });
const SignoutRow = Schema.Struct({ id: Schema.String, version: Schema.Int });
const StoreRow = Schema.Struct({
  version: Schema.Int,
  run: Schema.NullOr(Schema.String),
  dropped_at: Schema.NullOr(Schema.Int),
});
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
  /** The sites a shared tab showed as its page. */
  readonly sites: Map<Digest, BrowserSite>;
  /** Whether the sign-ins of before 0.16 were brought in. */
  readonly migrated: boolean;
  /** When the person last signed out of all sites, or the jar started again. */
  readonly clearedAt: number | undefined;
}

/** A host store's baseline: what it held when it last agreed with the jar. */
export interface StoreBaseline {
  /** The version up to which every sign-out reached the store. */
  readonly version: number;
  /** The run of its browser then, as the digests name it. */
  readonly run: Digest | undefined;
  readonly cookies: Map<Digest, Digest>;
  readonly origins: Map<Digest, Digest>;
  /**
   * What it held was dropped, after 90 days unseen: it is agreed as a new
   * store is, but with its version, so the sign-outs after it still win.
   */
  readonly dropped: boolean;
}

/** A change to one store's baseline: `replace` writes it whole. */
interface StoreCommit {
  readonly id: Digest;
  readonly version: number;
  readonly run: Digest | undefined;
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
  readonly sites?: {
    readonly set: ReadonlyArray<readonly [Digest, BrowserSite]>;
    readonly removed: ReadonlyArray<Digest> | "all";
  };
  readonly stores?: ReadonlyArray<StoreCommit>;
  readonly migrated?: boolean;
  /** The person signed out of all sites now. */
  readonly cleared?: boolean;
}

export interface JarFile {
  /** The baseline of store `id`, if it has one. */
  readonly baseline: (id: Digest) => Effect.Effect<Option.Option<StoreBaseline>>;
  readonly commit: (change: JarCommit) => Effect.Effect<void>;
}

/** The jar open: its file, and what it holds. */
interface OpenJar {
  readonly file: JarFile;
  readonly contents: JarContents;
}

/** The jar as it opened. */
export type OpenedJar =
  | ({ readonly _tag: "open" } & OpenJar)
  | {
      readonly _tag: "unreadable";
      /** Deletes the file and makes it again, empty, under the key: for "Sign out of all sites". */
      readonly reset: Effect.Effect<OpenJar>;
    };

/**
 * Opens the database at `location` sealed under `key`, and every row of it:
 * no contents when the key check or a row does not open under the key. A
 * file without a key check is new, and gets one.
 */
const connect = Effect.fn("SignIns.connect")(function* (location: string, key: Uint8Array) {
  const sql = yield* SqliteClient.make({ filename: location }).pipe(
    Effect.provide(Reactivity.layer),
  );
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`PRAGMA secure_delete = ON`;
  yield* sql`PRAGMA journal_mode = WAL`;
  yield* migrate(migrations).pipe(Effect.provideService(SqlClient.SqlClient, sql));
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

  const baseline = Effect.fn("SignIns.baseline")(function* (id: Digest) {
    const store = yield* SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: StoreRow,
      execute: () => sql`SELECT version, run, dropped_at FROM stores WHERE id = ${id}`,
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
    return Option.some<StoreBaseline>({
      version: store.value.version,
      run: store.value.run ?? undefined,
      cookies,
      origins,
      dropped: store.value.dropped_at !== null,
    });
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
        if (change.cleared === true) yield* sql`UPDATE meta SET cleared_at = ${now} WHERE id = 1`;
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
        const sites = change.sites;
        if (sites?.removed === "all") yield* sql`DELETE FROM sites`;
        else for (const id of sites?.removed ?? []) yield* sql`DELETE FROM sites WHERE id = ${id}`;
        for (const [id, site] of sites?.set ?? []) {
          const sealed = yield* seal(id, "site", site);
          yield* sql`
            INSERT INTO sites (id, nonce, sealed) VALUES (${id}, ${sealed.nonce}, ${sealed.sealed})
            ON CONFLICT (id) DO NOTHING
          `;
        }
        for (const store of change.stores ?? []) {
          yield* sql`
            INSERT INTO stores (id, version, run, seen_at)
            VALUES (${store.id}, ${store.version}, ${store.run ?? null}, ${now})
            ON CONFLICT (id) DO UPDATE SET
              version = excluded.version, run = excluded.run, seen_at = excluded.seen_at
          `;
          if (store.replace) {
            yield* sql`DELETE FROM store_entries WHERE store = ${store.id}`;
            yield* sql`UPDATE stores SET dropped_at = NULL WHERE id = ${store.id}`;
          }
          yield* writeEntries(store.id, "cookie", store.cookies);
          yield* writeEntries(store.id, "origin", store.origins);
        }
      }),
    ).pipe(Effect.orDie);

  /**
   * What is old enough to go: tombstones, emptied origins, and what a store
   * not seen for long held. The store's version stays, so a sign-out after
   * it still wins when it comes back.
   */
  const prune = inTransaction(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const before = now - KEPT_MS;
      yield* sql`DELETE FROM tombstones WHERE removed_at < ${before}`;
      yield* sql`DELETE FROM origins WHERE emptied_at < ${before}`;
      yield* sql`
        DELETE FROM store_entries WHERE store IN
          (SELECT id FROM stores WHERE seen_at < ${before} AND dropped_at IS NULL)
      `;
      yield* sql`
        UPDATE stores SET run = NULL, dropped_at = ${now}
        WHERE seen_at < ${before} AND dropped_at IS NULL
      `;
    }),
  );

  const sealedRows = (table: "cookies" | "origins" | "sites") =>
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: SealedRow,
      execute: () => sql`SELECT id, nonce, sealed FROM ${sql(table)}`,
    })(undefined);

  /** Every row, opened; none when one does not open under the key. */
  const openRows = <A>(
    rows: ReadonlyArray<typeof SealedRow.Type>,
    field: string,
    decode: (text: string) => Option.Option<A>,
  ): Option.Option<Map<Digest, A>> => {
    const opened = new Map<Digest, A>();
    for (const row of rows) {
      const value = Option.flatMap(open(row.id, field, row), decode);
      if (Option.isNone(value)) return Option.none();
      opened.set(row.id, value.value);
    }
    return Option.some(opened);
  };

  const file: JarFile = { baseline, commit };
  const meta = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: MetaRow,
    execute: () => sql`
      SELECT version, check_nonce, check_sealed, migrated_at, cleared_at FROM meta WHERE id = 1
    `,
  })(undefined);
  if (Option.isNone(meta)) {
    const check = yield* seal(KEY_CHECK_ID, "key", KEY_CHECK_TEXT);
    yield* inTransaction(sql`
      INSERT INTO meta (id, version, check_nonce, check_sealed)
      VALUES (1, 0, ${check.nonce}, ${check.sealed})
    `);
    return {
      file,
      contents: Option.some<JarContents>({
        version: 0,
        cookies: new Map(),
        tombstones: new Map(),
        origins: new Map(),
        signouts: new Map(),
        sites: new Map(),
        migrated: false,
        clearedAt: undefined,
      }),
    };
  }
  const check = open(KEY_CHECK_ID, "key", {
    nonce: meta.value.check_nonce,
    sealed: meta.value.check_sealed,
  });
  if (Option.getOrNull(check) !== KEY_CHECK_TEXT)
    return { file, contents: Option.none<JarContents>() };
  yield* prune;
  const cookies = openRows(yield* sealedRows("cookies"), "cookie", decodeCookie);
  const origins = openRows(yield* sealedRows("origins"), "origin", decodeOrigin);
  const sites = openRows(yield* sealedRows("sites"), "site", decodeSite);
  if (Option.isNone(cookies) || Option.isNone(origins) || Option.isNone(sites))
    return { file, contents: Option.none<JarContents>() };
  const tombstones = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: TombstoneRow,
    execute: () => sql`SELECT id, digest FROM tombstones`,
  })(undefined);
  const signouts = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: SignoutRow,
    execute: () => sql`SELECT id, version FROM signouts`,
  })(undefined);
  return {
    file,
    contents: Option.some<JarContents>({
      version: meta.value.version,
      cookies: cookies.value,
      tombstones: new Map(tombstones.map(({ id, digest }) => [id, digest])),
      origins: origins.value,
      signouts: new Map(signouts.map(({ id, version }) => [id, version])),
      sites: sites.value,
      migrated: meta.value.migrated_at !== null,
      clearedAt: meta.value.cleared_at ?? undefined,
    }),
  };
});

/**
 * Opens the sign-ins' file at `location`, sealed under `key`, for as long as
 * the scope lives. A file that cannot be opened is left as it is, until a
 * reset deletes it.
 */
export const openJarFile = Effect.fn("SignIns.openJarFile")(function* (
  location: string,
  key: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const outer = yield* Effect.scope;
  /** The scope the database is open in: closed, and made again, by a reset. */
  let connection = yield* Scope.fork(outer, "sequential");
  const connectIn = (scope: Scope.Scope) =>
    connect(location, key).pipe(
      Scope.provide(scope),
      Effect.provideService(SecureRandom.SecureRandom, random),
    );

  const reset = Effect.gen(function* () {
    yield* Scope.close(connection, Exit.void);
    for (const name of [location, ...BESIDE.map((suffix) => `${location}${suffix}`)])
      yield* fs.remove(name, { force: true });
    connection = yield* Scope.fork(outer, "sequential");
    const fresh = yield* connectIn(connection);
    if (Option.isNone(fresh.contents))
      return yield* Effect.die(new Error("A new sign-ins file did not open under its own key."));
    yield* fresh.file.commit({ version: 0, cleared: true });
    const contents: JarContents = {
      ...fresh.contents.value,
      clearedAt: yield* Clock.currentTimeMillis,
    };
    return { file: fresh.file, contents } satisfies OpenJar;
  }).pipe(Effect.orDie);

  const opened = yield* connectIn(connection).pipe(
    Effect.asSome,
    Effect.catch((error) =>
      Effect.logError(
        "The browser's sign-ins' file does not open: nothing is synced until the person signs out of all sites",
      ).pipe(Effect.annotateLogs({ detail: error.message }), Effect.as(Option.none())),
    ),
  );
  if (Option.isNone(opened)) return { _tag: "unreadable", reset } as const satisfies OpenedJar;
  const { file, contents } = opened.value;
  if (Option.isNone(contents)) {
    yield* Effect.logError(
      "The browser's sign-ins do not open under the secrets' key: nothing is synced until the person signs out of all sites",
    );
    return { _tag: "unreadable", reset } as const satisfies OpenedJar;
  }
  return { _tag: "open", file, contents: contents.value } as const satisfies OpenedJar;
});
