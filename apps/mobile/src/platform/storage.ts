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
const decodeStored = Schema.decodeUnknownOption(StoredCredential);
const encodeStored = Schema.encodeSync(StoredCredential);

/** The server whose credential the device holds, if any: where the app connects at launch. */
export const storedServer = async (secure: SecureValue): Promise<string | null> =>
  Option.getOrNull(Option.map(decodeStored(await secure.get()), ({ server }) => server));

const credentialOf = (stored: StoredCredential): DeviceCredential => ({
  deviceId: stored.deviceId,
  token: Redacted.make(stored.token),
});

const sameCredential = (stored: StoredCredential, credential: DeviceCredential) =>
  stored.deviceId === credential.deviceId && stored.token === Redacted.value(credential.token);

interface DeviceStorage {
  readonly credentials: CredentialStore["Service"];
  readonly storage: ClientStorage["Service"];
}

/**
 * The credential store and the client storage of the app, for the server at
 * `server` (an origin). Every operation runs one at a time: the app has one
 * window, and a commit must never read the pairing copy while a save or a
 * clear has written only one of the two stores.
 */
export const makeDeviceStorage = Effect.fn("makeDeviceStorage")(function* (
  database: SqlDatabase,
  secure: SecureValue,
  server: string,
) {
  const oneAtATime = yield* Semaphore.make(1);
  const serial = <A, E>(effect: Effect.Effect<A, E>) => oneAtATime.withPermits(1)(effect);

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

  const readStored = Effect.tryPromise({
    try: () => secure.get(),
    catch: () => new CredentialStorageError({ operation: "load" }),
  }).pipe(Effect.map(decodeStored));

  /** The credential secure storage holds, with the pairing copy set to it. */
  const loadAndMend = (operation: CredentialStorageError["operation"]) =>
    readStored.pipe(
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
    clear: Effect.fn("CredentialStore.clear")((credential: DeviceCredential) =>
      serial(
        readStored.pipe(
          Effect.mapError(() => new CredentialStorageError({ operation: "clear" })),
          Effect.flatMap((stored) =>
            Option.exists(stored, (found) => sameCredential(found, credential))
              ? Effect.tryPromise({
                  try: async () => {
                    await transaction((sql) => setPairingCopy(sql, null));
                    await secure.remove();
                  },
                  catch: () => new CredentialStorageError({ operation: "clear" }),
                })
              : Effect.void,
          ),
          Effect.andThen(loadAndMend("clear")),
        ),
      ),
    ),
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

  return { credentials, storage } satisfies DeviceStorage;
});
