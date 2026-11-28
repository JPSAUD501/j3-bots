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
//   that holds it open does not stop the write. Deleting a database a page
//   holds open fails the write at once, rather than waiting on the page.
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
}

interface PageDatabase {
  readonly objectStoreNames: PageNameList;
  transaction(names: ReadonlyArray<string>, mode: "readonly" | "readwrite"): PageTransaction;
  createObjectStore(
    name: string,
    options: { readonly autoIncrement: boolean; readonly keyPath?: PageKeyPath },
  ): PageObjectStore;
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

/** Every database of the page's origin, with every record, read in one transaction each. */
export const readDatabases = async (): Promise<ReadonlyArray<DatabaseDump>> => {
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
        return { a: items.map(visit), id };
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) plain = false;
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

  const dumps: Array<DatabaseDump> = [];
  for (const info of await indexedDB.databases()) {
    if (info.name === undefined || info.version === undefined) continue;
    const db = await settled(indexedDB.open(info.name));
    try {
      const storeNames = names(db.objectStoreNames);
      if (storeNames.length === 0) {
        dumps.push({ name: info.name, version: info.version, stores: [] });
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
      dumps.push({ name: info.name, version: info.version, stores });
    } finally {
      db.close();
    }
  }
  return dumps;
};

/**
 * Makes the page's origin hold exactly `databases`: every other database of
 * it is deleted, and each given one holds its records and nothing else.
 */
export const replaceDatabases = async (
  databases: ReadonlyArray<BrowserIndexedDb>,
): Promise<void> => {
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

  type Store = BrowserIndexedDb["stores"][number];
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

  const remove = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error(request.error?.message ?? "IndexedDB failed."));
      request.onblocked = () => reject(new Error("A page of the origin holds a database open."));
    });

  /** Fills `db`, emptied first, with the records of `stores`, in one transaction. */
  const fill = (db: PageDatabase, stores: ReadonlyArray<Store>) =>
    new Promise<void>((resolve, reject) => {
      if (stores.length === 0) return resolve();
      const transaction = db.transaction(
        stores.map((store) => store.name),
        "readwrite",
      );
      transaction.oncomplete = () => resolve();
      const failed = () =>
        reject(new Error(transaction.error?.message ?? "The database could not be written."));
      transaction.onerror = failed;
      transaction.onabort = failed;
      for (const store of stores) {
        const objectStore = transaction.objectStore(store.name);
        objectStore.clear();
        for (const record of store.records) {
          const value =
            "valueEncoded" in record ? decode(record.valueEncoded, new Map()) : record.value;
          const key = "keyEncoded" in record ? decode(record.keyEncoded, new Map()) : record.key;
          if (key === undefined) objectStore.add(value);
          else objectStore.add(value, key);
        }
      }
    });

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

  const present = await indexedDB.databases();
  const wanted = new Set(databases.map((database) => database.name));
  for (const info of present)
    if (info.name !== undefined && !wanted.has(info.name)) await remove(info.name);

  for (const database of databases) {
    const current = present.find((info) => info.name === database.name);
    if (current !== undefined && current.version === database.version) {
      const db = await settled(indexedDB.open(database.name));
      try {
        if (sameShape(db, database.stores)) {
          await fill(db, database.stores);
          continue;
        }
      } finally {
        db.close();
      }
    }
    if (current !== undefined) await remove(database.name);
    const request = indexedDB.open(database.name, database.version);
    request.onupgradeneeded = () => {
      for (const store of database.stores) {
        const keyPath = keyPathOf(store);
        const objectStore = request.result.createObjectStore(store.name, {
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
      }
    };
    const db = await settled(request);
    try {
      await fill(db, database.stores);
    } finally {
      db.close();
    }
  }
};
