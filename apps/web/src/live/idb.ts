// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The client's IndexedDB database. One record per key in each store, so two
 * tabs of the app never overwrite each other's records. Only pages of the
 * server's own origin can open it.
 */

export type Store = "credentials" | "drafts" | "outbox";

const NAME = "j3-bots";
const VERSION = 1;
const STORES: ReadonlyArray<Store> = ["credentials", "drafts", "outbox"];

const done = <A>(request: IDBRequest<A>) =>
  new Promise<A>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const committed = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

let opening: Promise<IDBDatabase> | null = null;

/** The open database. A failure to open is not kept: the next call tries again. */
const database = (): Promise<IDBDatabase> => {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = () => {
      for (const store of STORES) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the database closes this connection; the next call reopens it.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("The database is held open by an older tab"));
  }).catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
};

export async function get(store: Store, key: string): Promise<unknown> {
  const transaction = (await database()).transaction(store, "readonly");
  return done(transaction.objectStore(store).get(key));
}

export async function getAll(store: Store): Promise<ReadonlyMap<string, unknown>> {
  const transaction = (await database()).transaction(store, "readonly");
  const objects = transaction.objectStore(store);
  const [keys, values] = await Promise.all([done(objects.getAllKeys()), done(objects.getAll())]);
  const records = new Map<string, unknown>();
  keys.forEach((key, index) => {
    if (typeof key === "string") records.set(key, values[index]);
  });
  return records;
}

export async function put(store: Store, key: string, value: string): Promise<void> {
  const transaction = (await database()).transaction(store, "readwrite");
  transaction.objectStore(store).put(value, key);
  return committed(transaction);
}

export async function remove(store: Store, key: string): Promise<void> {
  const transaction = (await database()).transaction(store, "readwrite");
  transaction.objectStore(store).delete(key);
  return committed(transaction);
}

export async function clear(store: Store): Promise<void> {
  const transaction = (await database()).transaction(store, "readwrite");
  transaction.objectStore(store).clear();
  return committed(transaction);
}

/** Puts or deletes (`value: null`) each record, all in one transaction: every change or none. */
export async function commit(
  changes: ReadonlyArray<{
    readonly store: Store;
    readonly key: string;
    readonly value: string | null;
  }>,
): Promise<void> {
  const stores = [...new Set(changes.map((change) => change.store))];
  const transaction = (await database()).transaction(stores, "readwrite");
  for (const { store, key, value } of changes) {
    if (value === null) transaction.objectStore(store).delete(key);
    else transaction.objectStore(store).put(value, key);
  }
  return committed(transaction);
}
