// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics globalDate:off -- The pages store and check dates of their own, as sites do.
import { assert, describe, layer } from "@effect/vitest";
import { BrowserIndexedDb } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { readDatabases, replaceDatabases } from "./indexedDb.ts";

/** A Chromium to drive; CI and the checks set it, and without one these tests are skipped. */
const executablePath = process.env["J3_TEST_CHROMIUM"];

/** A fake site, answered by the test itself: nothing leaves the machine. */
const SITE = "http://app.test";

const decodeRead = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ readable: Schema.Literal(true), databases: Schema.Array(BrowserIndexedDb) }),
    Schema.Struct({ readable: Schema.Literal(false) }),
  ]),
);

/** Every database of `page`'s origin, read by `readDatabases`, which must be able to. */
const readAll = (page: Page) =>
  Effect.gen(function* () {
    const read = yield* decodeRead(yield* Effect.promise(() => page.evaluate(readDatabases)));
    if (!read.readable) return yield* Effect.die("The databases could not be read");
    return read.databases;
  });

/** Writes `databases` to `page`'s origin, version changes allowed unless said. */
const write = (page: Page, databases: ReadonlyArray<BrowserIndexedDb>, versionChanges = true) =>
  Effect.promise(() => page.evaluate(replaceDatabases, { databases, versionChanges }));
const decodeState = Schema.decodeUnknownEffect(
  Schema.Struct({
    origins: Schema.Array(
      Schema.Struct({
        origin: Schema.String,
        indexedDB: Schema.optionalKey(Schema.Array(BrowserIndexedDb)),
      }),
    ),
  }),
);

/** The Chromium the file's tests share, launched once and closed after the last: each test opens contexts of its own. */
class TestBrowser extends Context.Service<TestBrowser, Browser>()(
  "@j3-bots/browser/indexedDb.test/TestBrowser",
) {}

const launched = Layer.effect(
  TestBrowser,
  Effect.acquireRelease(
    Effect.promise(() =>
      chromium.launch({
        ...(executablePath === undefined ? {} : { executablePath }),
        headless: true,
      }),
    ),
    (browser) => Effect.promise(() => browser.close()),
  ),
);

/** A page of the fake site in `context`, whose every request gets an empty page. */
const pageOf = (context: BrowserContext) =>
  Effect.promise(async () => {
    await context.route("**/*", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" }),
    );
    const page = await context.newPage();
    await page.goto(`${SITE}/`);
    return page;
  });

const freshPage = (browser: Browser) =>
  Effect.acquireRelease(
    Effect.promise(() => browser.newContext()),
    (context) => Effect.promise(() => context.close()),
  ).pipe(Effect.flatMap(pageOf));

/** Stores what a site might: a value of every kind JSON cannot hold, and keys outside the values. */
const storeEverything = (page: Page) =>
  page.evaluate(async () => {
    const opened = indexedDB.open("kept", 3);
    opened.onupgradeneeded = () => {
      const records = opened.result.createObjectStore("records", { keyPath: "id" });
      records.createIndex("byWhen", "when", { unique: false });
      opened.result.createObjectStore("loose");
      opened.result.createObjectStore("counted", { autoIncrement: true });
    };
    const db = await new Promise<IDBDatabase>((resolve) => {
      opened.onsuccess = () => resolve(opened.result);
    });
    const shared = { label: "shared" };
    const transaction = db.transaction(["records", "loose", "counted"], "readwrite");
    transaction.objectStore("records").put({
      id: 1,
      when: new Date("2026-01-02T03:04:05.678Z"),
      bytes: new Uint8Array([1, 2, 255]),
      tags: new Set(["a", "b"]),
      map: new Map([["k", 1]]),
      big: 12345678901234567890n,
      odd: [NaN, -0, Infinity],
      twice: [shared, shared],
    });
    transaction.objectStore("records").put({ id: 2, name: "plain", nested: { list: [1, "two"] } });
    transaction.objectStore("loose").put("by date", new Date("2026-05-06T00:00:00.000Z"));
    transaction.objectStore("loose").put("by array", [1, "a"]);
    transaction.objectStore("counted").put({ n: 1 });
    await new Promise((resolve) => {
      transaction.oncomplete = resolve;
    });
    db.close();
  });

/** What the page holds of `storeEverything`'s values, checked in the page. */
const checkEverything = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const opened = indexedDB.open("kept");
      opened.onsuccess = () => resolve(opened.result);
    });
    const get = <T>(store: string, key: IDBValidKey) =>
      new Promise<T>((resolve) => {
        const request = db.transaction(store).objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
      });
    const first = await get<{
      when: Date;
      bytes: Uint8Array;
      tags: Set<string>;
      map: Map<string, number>;
      big: bigint;
      odd: Array<number>;
      twice: Array<object>;
    }>("records", 1);
    const second = await get<object>("records", 2);
    const records = db.transaction("records").objectStore("records");
    const checks = {
      version: db.version,
      date: first.when instanceof Date && first.when.toISOString(),
      bytes: first.bytes instanceof Uint8Array && [...first.bytes].join(),
      set: first.tags instanceof Set && [...first.tags].join(),
      map: first.map instanceof Map && first.map.get("k"),
      big: typeof first.big === "bigint" && first.big.toString(),
      odd: `${Number.isNaN(first.odd[0])} ${Object.is(first.odd[1], -0)} ${first.odd[2]}`,
      shared: first.twice[0] === first.twice[1],
      plain: JSON.stringify(second),
      index: records.index("byWhen").keyPath,
      byDate: await get<string>("loose", new Date("2026-05-06T00:00:00.000Z")),
      byArray: await get<string>("loose", [1, "a"]),
      counted: JSON.stringify(await get<object>("counted", 1)),
    };
    db.close();
    return checks;
  });

const EVERYTHING = {
  version: 3,
  date: "2026-01-02T03:04:05.678Z",
  bytes: "1,2,255",
  set: "a,b",
  map: 1,
  big: "12345678901234567890",
  odd: "true true Infinity",
  shared: true,
  plain: JSON.stringify({ id: 2, name: "plain", nested: { list: [1, "two"] } }),
  index: "when",
  byDate: "by date",
  byArray: "by array",
  counted: JSON.stringify({ n: 1 }),
};

/** Opens database `name` in `page` and keeps it open, as a site's tab does. */
const holdOpen = (page: Page, name: string) =>
  page.evaluate(
    (database) =>
      new Promise<void>((resolve) => {
        const opened = indexedDB.open(database);
        opened.onsuccess = () => {
          Reflect.set(globalThis, "held", opened.result);
          resolve();
        };
      }),
    name,
  );

describe.skipIf(executablePath === undefined)("an origin's IndexedDB", () => {
  layer(launched, { excludeTestServices: true })("read and written in a page", (it) => {
    it.effect("comes back as it was, values JSON cannot hold included", () =>
      Effect.gen(function* () {
        const browser = yield* TestBrowser;
        const from = yield* freshPage(browser);
        yield* Effect.promise(() => storeEverything(from));
        const read = yield* readAll(from);

        const to = yield* freshPage(browser);
        assert.strictEqual(yield* write(to, read), "written");
        assert.deepStrictEqual(yield* Effect.promise(() => checkEverything(to)), EVERYTHING);
      }).pipe(Effect.scoped),
    );

    it.effect("is in Playwright's own shape: each restores what the other read", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const browser = yield* TestBrowser;
        const from = yield* freshPage(browser);
        yield* Effect.promise(() => storeEverything(from));

        // Ours, restored by Playwright: its types leave `indexedDB` out, so the state is a file.
        const read = yield* readAll(from);
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "j3-indexeddb-" });
        const file = path.join(folder, "state.json");
        yield* fs.writeFileString(
          file,
          JSON.stringify({
            cookies: [],
            origins: [{ origin: SITE, localStorage: [], indexedDB: read }],
          }),
        );
        const theirs = yield* Effect.acquireRelease(
          Effect.promise(() => browser.newContext({ storageState: file })),
          (context) => Effect.promise(() => context.close()),
        ).pipe(Effect.flatMap(pageOf));
        assert.deepStrictEqual(yield* Effect.promise(() => checkEverything(theirs)), EVERYTHING);

        // Playwright's, restored by ours.
        const state = yield* decodeState(
          yield* Effect.promise(() => from.context().storageState({ indexedDB: true })),
        );
        const dumped = state.origins.find(({ origin }) => origin === SITE)?.indexedDB ?? [];
        const ours = yield* freshPage(browser);
        assert.strictEqual(yield* write(ours, dumped), "written");
        assert.deepStrictEqual(yield* Effect.promise(() => checkEverything(ours)), EVERYTHING);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect("is written past a tab that holds the database open, when its shape stays", () =>
      Effect.gen(function* () {
        const browser = yield* TestBrowser;
        const from = yield* freshPage(browser);
        yield* Effect.promise(() => storeEverything(from));
        const read = yield* readAll(from);

        // The tab's database has the same shape, a record more, and stays open.
        const tab = yield* freshPage(browser);
        yield* Effect.promise(() => storeEverything(tab));
        yield* Effect.promise(() => holdOpen(tab, "kept"));
        yield* Effect.promise(() =>
          tab.evaluate(
            () =>
              new Promise((resolve) => {
                const opened = indexedDB.open("kept");
                opened.onsuccess = () => {
                  const transaction = opened.result.transaction("records", "readwrite");
                  transaction.objectStore("records").put({ id: 3, name: "only here" });
                  transaction.oncomplete = () => {
                    opened.result.close();
                    resolve(undefined);
                  };
                };
              }),
          ),
        );
        const probe = yield* Effect.promise(() => tab.context().newPage());
        yield* Effect.promise(() => probe.goto(`${SITE}/`));
        // No version change, so it is written even when none may be made.
        assert.strictEqual(
          yield* write(probe, read, false).pipe(Effect.timeout("5 seconds")),
          "written",
        );
        assert.deepStrictEqual(yield* Effect.promise(() => checkEverything(probe)), EVERYTHING);
        const count = yield* Effect.promise(() =>
          probe.evaluate(
            () =>
              new Promise<number>((resolve) => {
                const opened = indexedDB.open("kept");
                opened.onsuccess = () => {
                  const request = opened.result
                    .transaction("records")
                    .objectStore("records")
                    .count();
                  request.onsuccess = () => resolve(request.result);
                };
              }),
          ),
        );
        assert.strictEqual(count, 2);
      }).pipe(Effect.scoped),
    );

    it.effect("changes nothing when a version change is needed and none may be made", () =>
      Effect.gen(function* () {
        const browser = yield* TestBrowser;
        const tab = yield* freshPage(browser);
        yield* Effect.promise(() => storeEverything(tab));
        yield* Effect.promise(() => holdOpen(tab, "kept"));
        const probe = yield* Effect.promise(() => tab.context().newPage());
        yield* Effect.promise(() => probe.goto(`${SITE}/`));
        const read = yield* readAll(probe);
        const [kept] = read;
        if (kept === undefined) return yield* Effect.die("Nothing was stored");

        const asked = [
          [],
          [{ ...kept, version: 4 }],
          [{ ...kept, stores: kept.stores.slice(1) }],
        ] as const;
        for (const databases of asked)
          assert.strictEqual(
            yield* write(probe, databases, false).pipe(Effect.timeout("5 seconds")),
            "version-change",
          );
        assert.deepStrictEqual(yield* Effect.promise(() => checkEverything(probe)), EVERYTHING);
      }).pipe(Effect.scoped),
    );

    it.effect("leaves a database as it was when a record cannot be written", () =>
      Effect.gen(function* () {
        const browser = yield* TestBrowser;
        const page = yield* freshPage(browser);
        yield* Effect.promise(() => storeEverything(page));
        const [kept] = yield* readAll(page);
        if (kept === undefined) return yield* Effect.die("Nothing was stored");
        // A record of `records` without the `id` its key path names, written first.
        const broken = (database: BrowserIndexedDb): BrowserIndexedDb => ({
          ...database,
          stores: database.stores.map((store) =>
            store.name === "records"
              ? { ...store, records: [{ value: { name: "no id" } }, ...store.records] }
              : store,
          ),
        });

        for (const database of [broken(kept), broken({ ...kept, version: 4 })]) {
          const outcome = yield* Effect.promise(() =>
            page.evaluate(replaceDatabases, { databases: [database], versionChanges: true }).then(
              (written) => written,
              () => "failed",
            ),
          );
          assert.strictEqual(outcome, "failed");
          assert.deepStrictEqual(yield* Effect.promise(() => checkEverything(page)), EVERYTHING);
        }
      }).pipe(Effect.scoped),
    );

    it.effect("reads nothing of an origin whose databases hold a value it cannot carry", () =>
      Effect.gen(function* () {
        const browser = yield* TestBrowser;
        const page = yield* freshPage(browser);
        yield* Effect.promise(() => storeEverything(page));
        yield* Effect.promise(() =>
          page.evaluate(
            () =>
              new Promise((resolve) => {
                const opened = indexedDB.open("kept");
                opened.onsuccess = () => {
                  const transaction = opened.result.transaction("loose", "readwrite");
                  transaction.objectStore("loose").put(new Blob(["bytes"]), "a blob");
                  transaction.oncomplete = () => {
                    opened.result.close();
                    resolve(undefined);
                  };
                };
              }),
          ),
        );
        assert.deepStrictEqual(
          yield* decodeRead(yield* Effect.promise(() => page.evaluate(readDatabases))),
          { readable: false },
        );
      }).pipe(Effect.scoped),
    );
  });
});
