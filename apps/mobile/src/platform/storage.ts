// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ClientStorage,
  CredentialStorageError,
  CredentialStore,
  type DeviceCredential,
  type LocalRecord,
  LocalStorageError,
  type LocalTable,
} from "@j3-bots/client-runtime";
import { DeviceId, DeviceToken } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

// What the app keeps on the device. The credential is in the platform's secure
// storage (the keychain or the keystore); drafts and unsent messages are in a
// SQLite database, with a copy of the paired device id beside them. Secure
// storage cannot take part in a SQLite transaction, so a transaction guarded by
// a pairing reads that copy instead (see `ClientStorage.commit`). The copy
// leads: a save writes it before the credential and a clear deletes it before
// the credential, so whenever the two disagree, the copy names a pairing that
// is starting, never one that ended. Loading the credential sets the copy to
// it, which mends what a crash between the two writes left.
//
// Both stores work through the interfaces below, so the same code runs over
// expo-sqlite and expo-secure-store in the app and over Node's SQLite in tests.

/** A value bound to a statement's `?`. */
type SqlValue = string | number | null;

/** Statements run inside one transaction. */
export interface SqlTransaction {
  readonly all: (sql: string, params?: ReadonlyArray<SqlValue>) => Promise<ReadonlyArray<unknown>>;
  readonly run: (sql: string, params?: ReadonlyArray<SqlValue>) => Promise<void>;
}

/** A SQLite database: `transaction` commits what `work` ran, or rolls it all back if `work` throws. */
export interface SqlDatabase {
  readonly transaction: <A>(work: (sql: SqlTransaction) => Promise<A>) => Promise<A>;
}

/** The one value the app keeps in the platform's secure storage. */
export interface SecureValue {
  readonly get: () => Promise<string | null>;
  readonly set: (value: string) => Promise<void>;
  readonly remove: () => Promise<void>;
}

const SCHEMA_VERSION = 1;

/** Creates the tables once, and records that it did in `user_version`. */
const migrate = async (sql: SqlTransaction) => {
  const [row] = await sql.all("PRAGMA user_version");
  const version = Schema.decodeUnknownOption(Schema.Struct({ user_version: Schema.Number }))(row);
  if (Option.exists(version, ({ user_version }) => user_version >= SCHEMA_VERSION)) return;
  await sql.run(
    `CREATE TABLE IF NOT EXISTS records (
       tbl TEXT NOT NULL,
       key TEXT NOT NULL,
       value TEXT NOT NULL,
       PRIMARY KEY (tbl, key)
     ) WITHOUT ROWID`,
  );
  // At most one row: the device id of the credential secure storage holds.
  await sql.run(
    `CREATE TABLE IF NOT EXISTS pairing (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       device_id TEXT NOT NULL
     )`,
  );
  await sql.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
};

const RecordRow = Schema.Struct({ key: Schema.String, value: Schema.String });
const ValueRow = Schema.Struct({ value: Schema.String });
const PairingRow = Schema.Struct({ device_id: Schema.String });
const decodeRows = Schema.decodeUnknownSync(Schema.Array(RecordRow));
const decodeValue = Schema.decodeUnknownOption(ValueRow);
const decodePairing = Schema.decodeUnknownOption(PairingRow);

const pairingCopy = async (sql: SqlTransaction): Promise<string | null> => {
  const [row] = await sql.all("SELECT device_id FROM pairing WHERE id = 1");
  return Option.getOrNull(Option.map(decodePairing(row), ({ device_id }) => device_id));
};

const setPairingCopy = (sql: SqlTransaction, deviceId: string | null) =>
  deviceId === null
    ? sql.run("DELETE FROM pairing WHERE id = 1")
    : sql.run("INSERT OR REPLACE INTO pairing (id, device_id) VALUES (1, ?)", [deviceId]);

/**
 * The device credential as secure storage keeps it, with the origin of the
 * server that issued it: a token must never reach another server.
 */
const StoredCredential = Schema.fromJsonString(
  Schema.Struct({ deviceId: DeviceId, token: DeviceToken, server: Schema.String }),
);
type StoredCredential = typeof StoredCredential.Type;
const decodeStored = Schema.decodeUnknownEffect(StoredCredential);
const encodeStored = Schema.encodeSync(StoredCredential);

/**
 * The credential secure storage holds, if any. A value that does not decode
 * is damaged storage, never a missing credential: taken for none, it would
 * open pairing, and pairing again would overwrite it while its device stays
 * listed on the server.
 */
const readStored = (secure: SecureValue) =>
  Effect.tryPromise({
    try: () => secure.get(),
    catch: () => new CredentialStorageError({ operation: "load" }),
  }).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.succeedNone
        : decodeStored(value).pipe(
            Effect.asSome,
            Effect.mapError(() => new CredentialStorageError({ operation: "load" })),
          ),
    ),
  );

/**
 * The server whose credential the device holds, if any: where the app
 * connects at launch. Fails when the credential cannot be read or decoded.
 */
export const storedServer = (secure: SecureValue) =>
  readStored(secure).pipe(Effect.map(Option.map(({ server }) => server)));

const credentialOf = (stored: StoredCredential): DeviceCredential => ({
  deviceId: stored.deviceId,
  token: Redacted.make(stored.token),
});

const sameCredential = (stored: StoredCredential, credential: DeviceCredential) =>
  stored.deviceId === credential.deviceId && stored.token === Redacted.value(credential.token);

/**
 * Every operation on the device's storage runs one at a time, across every
 * storage the app makes: a client being replaced can still write while the
 * next one starts, and they share one database connection, where a statement
 * of one must never run inside the other's transaction. A commit must also
 * never read the pairing copy while a save or a clear has written only one of
 * the two stores.
 */
const oneAtATime = Semaphore.makeUnsafe(1);
const serial = <A, E>(effect: Effect.Effect<A, E>) => oneAtATime.withPermits(1)(effect);

/**
 * Deletes the pairing the device holds: the copy of its device id, then the
 * credential, as the copy leads. Given `records: "deleted"`, the copy's
 * transaction deletes every record too, all of that pairing or of one that
 * ended before it; a client erases its pairing's records itself.
 */
const erase = async (database: SqlDatabase, secure: SecureValue, records: "kept" | "deleted") => {
  await database.transaction(async (sql) => {
    await migrate(sql);
    await setPairingCopy(sql, null);
    if (records === "deleted") await sql.run("DELETE FROM records");
  });
  await secure.remove();
};

/**
 * Forgets the pairing the device holds, whether its credential can be read
 * or not, with its drafts and unsent messages: the way on from a credential
 * that cannot be read, and from one for a server the app no longer accepts.
 */
export const forgetPairing = (database: SqlDatabase, secure: SecureValue) =>
  serial(
    Effect.tryPromise({
      try: () => erase(database, secure, "deleted"),
      catch: () => new CredentialStorageError({ operation: "clear" }),
    }),
  );

interface DeviceStorage {
  readonly credentials: CredentialStore["Service"];
  readonly storage: ClientStorage["Service"];
}

/**
 * The credential store and the client storage of the app, for the server at
 * `server` (an origin). Every operation runs one at a time with those of
 * every other storage (see `serial`).
 */
export const makeDeviceStorage = (
  database: SqlDatabase,
  secure: SecureValue,
  server: string,
): DeviceStorage => {
  // The tables are made by the first transaction that commits, so a failure
  // to make them is tried again by the next one rather than kept.
  let migrated = false;
  const transaction = async <A>(work: (sql: SqlTransaction) => Promise<A>): Promise<A> => {
    const result = await database.transaction(async (sql) => {
      if (!migrated) await migrate(sql);
      return work(sql);
    });
    migrated = true;
    return result;
  };

  /** The credential secure storage holds, with the pairing copy set to it. */
  const loadAndMend = (operation: CredentialStorageError["operation"]) =>
    readStored(secure).pipe(
      Effect.mapError(() => new CredentialStorageError({ operation })),
      Effect.tap((stored) =>
        Effect.tryPromise({
          try: () =>
            transaction((sql) =>
              setPairingCopy(sql, Option.getOrNull(Option.map(stored, ({ deviceId }) => deviceId))),
            ),
          catch: () => new CredentialStorageError({ operation }),
        }),
      ),
      Effect.map((stored) =>
        Option.map(
          Option.filter(stored, (found) => found.server === server),
          credentialOf,
        ),
      ),
    );

  const credentials = CredentialStore.of({
    load: serial(loadAndMend("load")),
    save: Effect.fn("CredentialStore.save")((credential: DeviceCredential) =>
      serial(
        Effect.tryPromise({
          try: async () => {
            await transaction((sql) => setPairingCopy(sql, credential.deviceId));
            await secure.set(
              encodeStored({
                deviceId: credential.deviceId,
                token: Redacted.value(credential.token),
                server,
              }),
            );
          },
          catch: () => new CredentialStorageError({ operation: "save" }),
        }).pipe(
          // The copy already names the new pairing: set it back to what is stored.
          Effect.tapError(() => loadAndMend("save").pipe(Effect.ignore)),
        ),
      ),
    ),
    // Whether the server refused the credential is kept by the client that
    // heard it; the app has one window, so no other ever needs to read it.
    clear: Effect.fn("CredentialStore.clear")((credential: DeviceCredential) =>
      serial(
        readStored(secure).pipe(
          Effect.mapError(() => new CredentialStorageError({ operation: "clear" })),
          Effect.flatMap((stored) =>
            Option.exists(stored, (found) => sameCredential(found, credential))
              ? Effect.tryPromise({
                  try: () => erase(database, secure, "kept"),
                  catch: () => new CredentialStorageError({ operation: "clear" }),
                })
              : Effect.void,
          ),
          Effect.andThen(loadAndMend("clear")),
        ),
      ),
    ),
    refusedPairing: Effect.succeedNone,
    // The app has one window: nothing else changes the credential.
    changes: Stream.never,
  });

  const run = <A>(
    operation: LocalStorageError["operation"],
    work: (sql: SqlTransaction) => Promise<A>,
  ) =>
    serial(
      Effect.tryPromise({
        try: () => transaction(work),
        catch: () => new LocalStorageError({ operation }),
      }),
    );

  const applyChange = (sql: SqlTransaction, { table, key, value }: LocalRecord) =>
    value === null
      ? sql.run("DELETE FROM records WHERE tbl = ? AND key = ?", [table, key])
      : sql.run("INSERT OR REPLACE INTO records (tbl, key, value) VALUES (?, ?, ?)", [
          table,
          key,
          value,
        ]);

  const holds = async (sql: SqlTransaction, { table, key, value }: LocalRecord) => {
    const [row] = await sql.all("SELECT value FROM records WHERE tbl = ? AND key = ?", [
      table,
      key,
    ]);
    return Option.getOrNull(Option.map(decodeValue(row), (found) => found.value)) === value;
  };

  const storage = ClientStorage.of({
    readAll: Effect.fn("ClientStorage.readAll")((table: LocalTable) =>
      run("read", async (sql) => {
        const rows = decodeRows(
          await sql.all("SELECT key, value FROM records WHERE tbl = ? ORDER BY key", [table]),
        );
        return new Map(rows.map(({ key, value }) => [key, value]));
      }),
    ),
    write: Effect.fn("ClientStorage.write")((table: LocalTable, key: string, value: string) =>
      run("write", (sql) => applyChange(sql, { table, key, value })),
    ),
    remove: Effect.fn("ClientStorage.remove")((table: LocalTable, key: string) =>
      run("remove", (sql) => applyChange(sql, { table, key, value: null })),
    ),
    clear: Effect.fn("ClientStorage.clear")((table: LocalTable) =>
      run("remove", (sql) => sql.run("DELETE FROM records WHERE tbl = ?", [table])),
    ),
    commit: Effect.fn("ClientStorage.commit")(
      (
        changes: ReadonlyArray<LocalRecord>,
        expected: ReadonlyArray<LocalRecord> = [],
        pairing?: DeviceId,
      ) =>
        run("write", async (sql) => {
          if (pairing !== undefined && (await pairingCopy(sql)) !== pairing) return false;
          for (const record of expected) if (!(await holds(sql, record))) return false;
          for (const change of changes) await applyChange(sql, change);
          return true;
        }),
    ),
    // The app has one window: nothing else changes these tables.
    changes: Stream.never,
  });

  return { credentials, storage };
};
