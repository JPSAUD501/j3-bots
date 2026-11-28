// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalDate:off -- These functions run in the page, where a stored date is the page's own Date.
// Reading and writing an origin's IndexedDB from a page of it follows
// Playwright v1.64.1, packages/injected/src/storageScript.ts, and its encoding
// of values JSON cannot hold, packages/isomorphic/utilityScriptSerializers.ts
// (Apache License 2.0, Copyright (c) Microsoft Corporation; see this
// package's NOTICE). What is read is in the shape Playwright's `storageState`
// reads and writes, so a database either one dumped the other restores.
//
// Changed from Playwright's:
// - Only IndexedDB: `localStorage` and the rest are the host's own calls.
// - A database of the same version and shape as the one written is emptied
//   and filled again in one transaction, not deleted, so a page of the origin
//   that holds it open does not stop the write. A write that needs a version
//   change (a delete, or an open at another version) is made only when the
//   caller says nothing can hold one back, and otherwise changes nothing.
//   An upgrade fills its stores in the version change's own transaction,
//   and every record is decoded first, so a failure leaves the database as
//   it was.
// - Reading never makes a database, and a value the encoding cannot carry
//   (a `CryptoKey`, a `Blob`) leaves the origin unread, not read wrong.
// - A number JSON cannot hold (`NaN`, the infinities, `-0`) and a value met
//   twice are encoded, so what comes back as plain JSON is plain JSON.
// - Values are told apart in the page's own realm (`instanceof`), as they
//   come from the origin's own database in Chromium.
//
// Both functions run in a page of the origin, and Playwright sends each
// one's source: neither may use anything outside its own body. The page's
// names they use are declared here, for this module alone, as in
// `driver/pageScripts.ts`.

import type { BrowserIndexedDb } from "@j3-bots/contracts";

/** A list of names, as IndexedDB gives one. */
interface PageNameList {
  readonly length: number;
  item(index: number): string | null;
}

interface PageError {
  readonly message: string;
}

interface PageRequest<T> {
  readonly result: T;
  readonly error: PageError | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface PageOpenRequest<T> extends PageRequest<T> {
  /** The version change's transaction, while `onupgradeneeded` runs. */
  readonly transaction: PageTransaction | null;
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
}

type PageKeyPath = string | ReadonlyArray<string>;

interface PageIndex {
  readonly name: string;
  readonly keyPath: PageKeyPath;
  readonly multiEntry: boolean;
  readonly unique: boolean;
}

interface PageObjectStore {
  readonly keyPath: PageKeyPath | null;
  readonly autoIncrement: boolean;
  readonly indexNames: PageNameList;
  index(name: string): PageIndex;
  getAllKeys(): PageRequest<ReadonlyArray<unknown>>;
  get(key: unknown): PageRequest<unknown>;
  add(value: unknown, key?: unknown): PageRequest<unknown>;
  clear(): PageRequest<undefined>;
  createIndex(
    name: string,
    keyPath: PageKeyPath,
    options: { readonly unique: boolean; readonly multiEntry: boolean },
  ): PageIndex;
}

interface PageTransaction {
  readonly error: PageError | null;
  objectStore(name: string): PageObjectStore;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  abort(): void;
}

interface PageDatabase {
  readonly version: number;
  readonly objectStoreNames: PageNameList;
  transaction(names: ReadonlyArray<string>, mode: "readonly" | "readwrite"): PageTransaction;
  createObjectStore(
    name: string,
    options: { readonly autoIncrement: boolean; readonly keyPath?: PageKeyPath },
  ): PageObjectStore;
  deleteObjectStore(name: string): void;
  close(): void;
}

interface PageDatabaseInfo {
  readonly name?: string;
  readonly version?: number;
}

interface PageIndexedDb {
  databases(): Promise<ReadonlyArray<PageDatabaseInfo>>;
  open(name: string, version?: number): PageOpenRequest<PageDatabase>;
  deleteDatabase(name: string): PageOpenRequest<undefined>;
}

declare const indexedDB: PageIndexedDb;

/** A database as `readDatabases` gives it: `BrowserIndexedDb`, before the host decodes it. */
export interface DatabaseDump {
  readonly name: string;
  readonly version: number;
  readonly stores: ReadonlyArray<{
    readonly name: string;
    readonly autoIncrement: boolean;
    readonly keyPath?: string;
    readonly keyPathArray?: ReadonlyArray<string>;
    readonly records: ReadonlyArray<{
      readonly key?: unknown;
      readonly keyEncoded?: unknown;
      readonly value?: unknown;
      readonly valueEncoded?: unknown;
    }>;
    readonly indexes: ReadonlyArray<{
      readonly name: string;
      readonly keyPath?: string;
      readonly keyPathArray?: ReadonlyArray<string>;
      readonly multiEntry: boolean;
      readonly unique: boolean;
    }>;
  }>;
}

/**
 * What `readDatabases` found: every database of the origin, or that one of
 * them holds a value the encoding cannot carry (a `CryptoKey`, a `Blob`, a
 * `DataView`), so none of them is read rather than read wrong.
 */
export type DatabasesRead =
  | { readonly readable: true; readonly databases: ReadonlyArray<DatabaseDump> }
  | { readonly readable: false };

/** Every database of the page's origin, with every record, read in one transaction each. */
export const readDatabases = async (): Promise<DatabasesRead> => {
  /** Whether a value the encoding cannot carry was met: then nothing is read. */
  let unsupported = false;
  const settled = <T>(request: PageRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(request.error?.message ?? "IndexedDB failed."));
    });
  const names = (list: PageNameList): ReadonlyArray<string> => {
    const all: Array<string> = [];
    for (let index = 0; index < list.length; index++) {
      const name = list.item(index);
      if (name !== null) all.push(name);
    }
    return all;
  };
  const keyPathOf = (keyPath: PageKeyPath | null) =>
    typeof keyPath === "string"
      ? { keyPath }
      : keyPath === null
        ? {}
        : { keyPathArray: [...keyPath] };

  const TYPED = [
    ["i8", Int8Array],
    ["ui8", Uint8Array],
    ["ui8c", Uint8ClampedArray],
    ["i16", Int16Array],
    ["ui16", Uint16Array],
    ["i32", Int32Array],
    ["ui32", Uint32Array],
    ["f32", Float32Array],
    ["f64", Float64Array],
    ["bi64", BigInt64Array],
    ["bui64", BigUint64Array],
  ] as const;
  const base64 = (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  /**
   * `value` in Playwright's encoding, and whether it is plain JSON: objects
   * of `Object` alone, arrays, strings, finite numbers, booleans and null,
   * none of them met twice.
   */
  const encode = (input: unknown): { readonly plain: boolean; readonly encoded: unknown } => {
    const seen = new Map<object, number>();
    let lastId = 0;
    let plain = true;
    /** `encoded`, for a value that is not plain JSON. */
    const special = (encoded: unknown) => {
      plain = false;
      return encoded;
    };
    const visit = (value: unknown): unknown => {
      if (value === undefined || typeof value === "symbol" || typeof value === "function")
        return special({ v: "undefined" });
      if (value === null) return { v: "null" };
      if (typeof value === "number") {
        if (Number.isNaN(value)) return special({ v: "NaN" });
        if (value === Infinity) return special({ v: "Infinity" });
        if (value === -Infinity) return special({ v: "-Infinity" });
        if (Object.is(value, -0)) return special({ v: "-0" });
        return value;
      }
      if (typeof value === "boolean" || typeof value === "string") return value;
      if (typeof value === "bigint") return special({ bi: value.toString() });
      if (typeof value !== "object") return special({ v: "undefined" });

      const known = seen.get(value);
      if (known !== undefined) return special({ ref: known });
      if (value instanceof Error) {
        const stack = value.stack?.startsWith(`${value.name}: ${value.message}`)
          ? value.stack
          : `${value.name}: ${value.message}\n${value.stack ?? ""}`;
        return special({ e: { n: value.name, m: value.message, s: stack } });
      }
      if (value instanceof Date)
        return special({ d: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toJSON() });
      if (value instanceof RegExp) return special({ r: { p: value.source, f: value.flags } });
      for (const [kind, Typed] of TYPED)
        if (value instanceof Typed)
          return special({
            ta: {
              b: base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
              k: kind,
            },
          });
      if (value instanceof ArrayBuffer)
        return special({ ab: { b: base64(new Uint8Array(value)) } });

      const id = ++lastId;
      seen.set(value, id);
      if (value instanceof Map) {
        plain = false;
        const entries: Array<{ k: unknown; v: unknown }> = [];
        for (const [key, item] of value) entries.push({ k: visit(key), v: visit(item) });
        return { m: entries, id };
      }
      if (value instanceof Set) {
        plain = false;
        const items: Array<unknown> = [];
        for (const item of value) items.push(visit(item));
        return { s: items, id };
      }
      if (Array.isArray(value)) {
        const items: ReadonlyArray<unknown> = value;
        // By index, so a hole is encoded as undefined rather than skipped.
        const encoded: Array<unknown> = [];
        for (let index = 0; index < items.length; index++) encoded.push(visit(items[index]));
        return { a: encoded, id };
      }
      // A `CryptoKey`, a `Blob`, a `DataView`, a class's instance: written back
      // as an object of its fields, it would be another value.
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        unsupported = true;
        return { v: "undefined" };
      }
      const fields: ReadonlyArray<readonly [string, unknown]> = Object.entries(value);
      return { o: fields.map(([k, item]) => ({ k, v: visit(item) })), id };
    };
    const encoded = visit(input);
    return { plain, encoded };
  };
  const keyOf = (key: unknown) => {
    const { plain, encoded } = encode(key);
    return plain ? { key } : { keyEncoded: encoded };
  };
  const valueOf = (value: unknown) => {
    const { plain, encoded } = encode(value);
    return plain ? { value } : { valueEncoded: encoded };
  };

  /** Opens database `name` as it is, or undefined if it is gone: an open must not create one. */
  const openExisting = (name: string) =>
    new Promise<PageDatabase | undefined>((resolve, reject) => {
      const request = indexedDB.open(name);
      let created = false;
      request.onupgradeneeded = () => {
        created = true;
        request.transaction?.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        created
          ? resolve(undefined)
          : reject(new Error(request.error?.message ?? "IndexedDB failed."));
    });

  const dumps: Array<DatabaseDump> = [];
  for (const info of await indexedDB.databases()) {
    if (info.name === undefined) continue;
    const db = await openExisting(info.name);
    if (db === undefined) continue;
    try {
      const storeNames = names(db.objectStoreNames);
      if (storeNames.length === 0) {
        dumps.push({ name: info.name, version: db.version, stores: [] });
        continue;
      }
      const transaction = db.transaction(storeNames, "readonly");
      const stores = await Promise.all(
        storeNames.map(async (storeName) => {
          const store = transaction.objectStore(storeName);
          const keys = await settled(store.getAllKeys());
          const records = await Promise.all(
            keys.map(async (key) => ({
              ...(store.keyPath === null ? keyOf(key) : {}),
              ...valueOf(await settled(store.get(key))),
            })),
          );
          return {
            name: storeName,
            autoIncrement: store.autoIncrement,
            ...keyPathOf(store.keyPath),
            records,
            indexes: names(store.indexNames).map((indexName) => {
              const index = store.index(indexName);
              return {
                name: index.name,
                ...keyPathOf(index.keyPath),
                multiEntry: index.multiEntry,
                unique: index.unique,
              };
            }),
          };
        }),
      );
      dumps.push({ name: info.name, version: db.version, stores });
    } finally {
      db.close();
    }
  }
  return unsupported ? { readable: false } : { readable: true, databases: dumps };
};

/**
 * What `replaceDatabases` did. `version-change`: the databases differ by more
 * than their records, so one must be deleted or opened at a new version,
 * which a page of the origin holding it open would block; nothing was
 * changed, and the host calls it again with `versionChanges` once nothing of
 * the origin can hold one open.
 */
export type DatabasesWritten = "written" | "version-change";

/**
 * Makes the page's origin hold exactly `databases`: every other database of
 * it is deleted, and each given one holds its records and nothing else.
 * Every record is decoded and every database compared before anything is
 * changed. A database of the same version and shape is emptied and filled
 * in one transaction. One at a higher version is upgraded in place: its
 * stores are replaced and filled in the version change's own transaction,
 * so a failure leaves it as it was. Deleting, or a database at a lower
 * version or of another shape, which is deleted and made again, happens only
 * with `versionChanges`.
 */
export const replaceDatabases = async (input: {
  readonly databases: ReadonlyArray<BrowserIndexedDb>;
  readonly versionChanges: boolean;
}): Promise<DatabasesWritten> => {
  const settled = <T>(request: PageRequest<T>) =>
    new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(request.error?.message ?? "IndexedDB failed."));
    });
  const names = (list: PageNameList): ReadonlyArray<string> => {
    const all: Array<string> = [];
    for (let index = 0; index < list.length; index++) {
      const name = list.item(index);
      if (name !== null) all.push(name);
    }
    return all;
  };
  const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const TYPED = {
    i8: Int8Array,
    ui8: Uint8Array,
    ui8c: Uint8ClampedArray,
    i16: Int16Array,
    ui16: Uint16Array,
    i32: Int32Array,
    ui32: Uint32Array,
    f32: Float32Array,
    f64: Float64Array,
    bi64: BigInt64Array,
    bui64: BigUint64Array,
  } as const;
  const isTypedKind = (kind: unknown): kind is keyof typeof TYPED =>
    typeof kind === "string" && Object.hasOwn(TYPED, kind);
  const bytesOf = (base64: string) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };

  /** A value Playwright encoded, as it was. A shape it does not know passes as it is. */
  const decode = (value: unknown, refs: Map<number, unknown>): unknown => {
    if (!isRecord(value)) return value;
    const id = typeof value["id"] === "number" ? value["id"] : undefined;
    if (typeof value["ref"] === "number") return refs.get(value["ref"]);
    if ("v" in value) {
      switch (value["v"]) {
        case "null":
          return null;
        case "NaN":
          return NaN;
        case "Infinity":
          return Infinity;
        case "-Infinity":
          return -Infinity;
        case "-0":
          return -0;
        default:
          return undefined;
      }
    }
    if (typeof value["d"] === "string") return new Date(value["d"]);
    // Playwright writes an invalid date as `{ d: null }`.
    if ("d" in value && value["d"] === null) return new Date(NaN);
    if (typeof value["bi"] === "string") return BigInt(value["bi"]);
    const error = value["e"];
    if (isRecord(error)) {
      const made = new Error(String(error["m"]));
      made.name = String(error["n"]);
      made.stack = String(error["s"]);
      return made;
    }
    const pattern = value["r"];
    if (isRecord(pattern)) return new RegExp(String(pattern["p"]), String(pattern["f"]));
    const typed = value["ta"];
    if (isRecord(typed) && typeof typed["b"] === "string" && isTypedKind(typed["k"]))
      return new TYPED[typed["k"]](bytesOf(typed["b"]).buffer);
    const buffer = value["ab"];
    if (isRecord(buffer) && typeof buffer["b"] === "string") return bytesOf(buffer["b"]).buffer;
    const items = value["a"];
    if (Array.isArray(items)) {
      const list: ReadonlyArray<unknown> = items;
      const result: Array<unknown> = [];
      if (id !== undefined) refs.set(id, result);
      for (const item of list) result.push(decode(item, refs));
      return result;
    }
    const fields = value["o"];
    if (Array.isArray(fields)) {
      const list: ReadonlyArray<unknown> = fields;
      const result: Record<string, unknown> = {};
      if (id !== undefined) refs.set(id, result);
      for (const field of list)
        if (isRecord(field) && typeof field["k"] === "string" && field["k"] !== "__proto__")
          result[field["k"]] = decode(field["v"], refs);
      return result;
    }
    const entries = value["m"];
    if (Array.isArray(entries)) {
      const list: ReadonlyArray<unknown> = entries;
      const result = new Map<unknown, unknown>();
      if (id !== undefined) refs.set(id, result);
      for (const entry of list)
        if (isRecord(entry)) result.set(decode(entry["k"], refs), decode(entry["v"], refs));
      return result;
    }
    const members = value["s"];
    if (Array.isArray(members)) {
      const list: ReadonlyArray<unknown> = members;
      const result = new Set<unknown>();
      if (id !== undefined) refs.set(id, result);
      for (const member of list) result.add(decode(member, refs));
      return result;
    }
    return value;
  };

  type Database = BrowserIndexedDb;
  type Store = Database["stores"][number];
  const keyPathOf = (shape: {
    readonly keyPath?: string;
    readonly keyPathArray?: ReadonlyArray<string>;
  }) => shape.keyPathArray ?? shape.keyPath;
  const samePath = (a: PageKeyPath | null | undefined, b: PageKeyPath | null | undefined) =>
    (a ?? null) === (b ?? null) ||
    (typeof a === "object" &&
      typeof b === "object" &&
      a !== null &&
      b !== null &&
      a.join("\u0000") === b.join("\u0000"));

  /** A store's records, decoded before anything is written. */
  interface Decoded {
    readonly store: Store;
    readonly records: ReadonlyArray<{ readonly value: unknown; readonly key: unknown }>;
  }
  const decoded = (database: Database): ReadonlyArray<Decoded> =>
    database.stores.map((store) => ({
      store,
      records: store.records.map((record) => ({
        value: "valueEncoded" in record ? decode(record.valueEncoded, new Map()) : record.value,
        key: "keyEncoded" in record ? decode(record.keyEncoded, new Map()) : record.key,
      })),
    }));

  /** Adds `stores`' records through `store`, rolling the transaction back on a throw. */
  const addAll = (
    transaction: PageTransaction,
    stores: ReadonlyArray<Decoded>,
    store: (decoded: Decoded) => PageObjectStore,
  ) => {
    try {
      for (const each of stores) {
        const objectStore = store(each);
        for (const { value, key } of each.records)
          if (key === undefined) objectStore.add(value);
          else objectStore.add(value, key);
      }
    } catch (error) {
      transaction.abort();
      throw error;
    }
  };

  /** Whether `db` has exactly the stores and indexes `wanted` has. */
  const sameShape = (db: PageDatabase, wanted: ReadonlyArray<Store>) => {
    const storeNames = names(db.objectStoreNames);
    if (storeNames.length !== wanted.length) return false;
    if (storeNames.length === 0) return true;
    const transaction = db.transaction(storeNames, "readonly");
    return wanted.every((store) => {
      if (!storeNames.includes(store.name)) return false;
      const objectStore = transaction.objectStore(store.name);
      const indexNames = names(objectStore.indexNames);
      return (
        objectStore.autoIncrement === store.autoIncrement &&
        samePath(objectStore.keyPath, keyPathOf(store)) &&
        indexNames.length === store.indexes.length &&
        store.indexes.every((index) => {
          if (!indexNames.includes(index.name)) return false;
          const found = objectStore.index(index.name);
          return (
            found.unique === index.unique &&
            found.multiEntry === index.multiEntry &&
            samePath(found.keyPath, keyPathOf(index))
          );
        })
      );
    });
  };

  /** Opens database `name` as it is, or undefined if it is gone: an open must not create one. */
  const openExisting = (name: string) =>
    new Promise<PageDatabase | undefined>((resolve, reject) => {
      const request = indexedDB.open(name);
      let created = false;
      request.onupgradeneeded = () => {
        created = true;
        request.transaction?.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        created
          ? resolve(undefined)
          : reject(new Error(request.error?.message ?? "IndexedDB failed."));
    });

  /**
   * Deletes database `name`. A page that holds it open delays the delete
   * until it lets go, and the delete cannot be called back, so this waits:
   * the host asks for it only once nothing of the origin is open.
   */
  const remove = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error(request.error?.message ?? "IndexedDB failed."));
    });

  /** Empties `db`'s stores and fills them again, in one transaction. */
  const refill = (db: PageDatabase, stores: ReadonlyArray<Decoded>) =>
    new Promise<void>((resolve, reject) => {
      if (stores.length === 0) return resolve();
      const transaction = db.transaction(
        stores.map(({ store }) => store.name),
        "readwrite",
      );
      transaction.oncomplete = () => resolve();
      const failed = () =>
        reject(new Error(transaction.error?.message ?? "The database could not be written."));
      transaction.onerror = failed;
      transaction.onabort = failed;
      try {
        for (const { store } of stores) transaction.objectStore(store.name).clear();
        addAll(transaction, stores, ({ store }) => transaction.objectStore(store.name));
      } catch (error) {
        reject(error);
      }
    });

  /**
   * Opens `database` at its version and, in the version change's own
   * transaction, replaces whatever stores it had with its stores and
   * records: all of it, or, on any failure, none of it.
   */
  const build = (database: Database, stores: ReadonlyArray<Decoded>) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(database.name, database.version);
      let failure: unknown;
      request.onupgradeneeded = () => {
        const db = request.result;
        const transaction = request.transaction;
        if (transaction === null) return;
        try {
          for (const name of names(db.objectStoreNames)) db.deleteObjectStore(name);
          const created = new Map<Store, PageObjectStore>();
          for (const { store } of stores) {
            const keyPath = keyPathOf(store);
            const objectStore = db.createObjectStore(store.name, {
              autoIncrement: store.autoIncrement,
              ...(keyPath === undefined ? {} : { keyPath }),
            });
            for (const index of store.indexes) {
              const indexPath = keyPathOf(index);
              if (indexPath !== undefined)
                objectStore.createIndex(index.name, indexPath, {
                  unique: index.unique,
                  multiEntry: index.multiEntry,
                });
            }
            created.set(store, objectStore);
          }
          addAll(transaction, stores, ({ store }) => {
            const objectStore = created.get(store);
            if (objectStore === undefined) throw new Error("A store was not made.");
            return objectStore;
          });
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () =>
        reject(
          failure instanceof Error
            ? failure
            : new Error(request.error?.message ?? "The database could not be written."),
        );
    });

  // Everything is read and compared first: nothing is changed until all of
  // it is known to be possible.
  type Step =
    | {
        readonly kind: "refill";
        readonly database: Database;
        readonly stores: ReadonlyArray<Decoded>;
      }
    | {
        readonly kind: "build";
        readonly database: Database;
        readonly stores: ReadonlyArray<Decoded>;
      }
    | {
        readonly kind: "rebuild";
        readonly database: Database;
        readonly stores: ReadonlyArray<Decoded>;
      }
    | { readonly kind: "delete"; readonly name: string };
  const steps: Array<Step> = [];
  const present = await indexedDB.databases();
  const wanted = new Set(input.databases.map((database) => database.name));
  for (const info of present)
    if (info.name !== undefined && !wanted.has(info.name))
      steps.push({ kind: "delete", name: info.name });
  for (const database of input.databases) {
    const stores = decoded(database);
    const db = present.some((info) => info.name === database.name)
      ? await openExisting(database.name)
      : undefined;
    if (db === undefined) {
      steps.push({ kind: "build", database, stores });
      continue;
    }
    try {
      if (db.version === database.version && sameShape(db, database.stores))
        steps.push({ kind: "refill", database, stores });
      else if (db.version < database.version) steps.push({ kind: "build", database, stores });
      else steps.push({ kind: "rebuild", database, stores });
    } finally {
      db.close();
    }
  }
  // A new database at a higher version than one there is a version change too.
  const changesVersions = steps.some(
    (step) =>
      step.kind === "delete" ||
      step.kind === "rebuild" ||
      (step.kind === "build" && present.some((info) => info.name === step.database.name)),
  );
  if (changesVersions && !input.versionChanges) return "version-change";

  for (const step of steps) {
    if (step.kind === "delete") await remove(step.name);
    else if (step.kind === "refill") {
      const db = await settled(indexedDB.open(step.database.name));
      try {
        await refill(db, step.stores);
      } finally {
        db.close();
      }
    } else {
      if (step.kind === "rebuild") await remove(step.database.name);
      await build(step.database, step.stores);
    }
  }
  return "written";
};
