// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the app's SQLite code runs here over Node's own SQLite, in place of expo-sqlite.
import * as NodeSqlite from "node:sqlite";
import type { DeviceCredential } from "@j3-bots/client-runtime";
import { DeviceId, DeviceToken } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  makeDeviceStorage,
  type SecureValue,
  type SqlDatabase,
  type SqlTransaction,
} from "./storage.ts";

const SERVER = "http://192.168.1.20:3737";

/** A database in memory, over Node's SQLite, with the transactions expo-sqlite gives the app. */
const memoryDatabase = (): SqlDatabase => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  const sql: SqlTransaction = {
    all: async (text, params = []) => db.prepare(text).all(...params),
    run: async (text, params = []) => {
      db.prepare(text).run(...params);
    },
  };
  return {
    transaction: async (work) => {
      db.exec("BEGIN");
      try {
        const result = await work(sql);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
};

/** Secure storage in memory, which fails to write while `failing` says so. */
const memorySecure = (failing: () => boolean = () => false) => {
  let held: string | null = null;
  const secure: SecureValue = {
    get: async () => held,
    set: async (value) => {
      if (failing()) throw new Error("the keystore refused");
      held = value;
    },
    remove: async () => {
      held = null;
    },
  };
  return secure;
};

const credential = (id: string): DeviceCredential => ({
  deviceId: Schema.decodeSync(DeviceId)(id),
  token: Redacted.make(Schema.decodeSync(DeviceToken)(`${id}-a-token-long-enough-for-the-schema`)),
});

const deviceId = (id: string) => Schema.decodeSync(DeviceId)(id);

describe("the app's storage", () => {
  it.effect("moves a record in one transaction, only while what it expects still holds", () =>
    Effect.gen(function* () {
      const { storage } = yield* makeDeviceStorage(memoryDatabase(), memorySecure(), SERVER);
      yield* storage.write("drafts", "bot:a", "hello");
      const move = [
        { table: "drafts" as const, key: "bot:a", value: null },
        { table: "outbox" as const, key: "c1", value: "hello" },
      ];
      const expected = [{ table: "drafts" as const, key: "bot:a", value: "hello" }];

      assert.isTrue(yield* storage.commit(move, expected));
      assert.deepStrictEqual([...(yield* storage.readAll("drafts"))], []);
      assert.deepStrictEqual([...(yield* storage.readAll("outbox"))], [["c1", "hello"]]);

      // The draft is gone now, so the same move writes nothing at all.
      const again = [
        { table: "drafts" as const, key: "bot:a", value: "edited" },
        { table: "outbox" as const, key: "c2", value: "hello" },
      ];
      assert.isFalse(yield* storage.commit(again, expected));
      assert.deepStrictEqual([...(yield* storage.readAll("drafts"))], []);
      assert.deepStrictEqual([...(yield* storage.readAll("outbox"))], [["c1", "hello"]]);
    }),
  );

  it.effect(
    "writes a pairing's records only while the device holds that pairing's credential",
    () =>
      Effect.gen(function* () {
        const { credentials, storage } = yield* makeDeviceStorage(
          memoryDatabase(),
          memorySecure(),
          SERVER,
        );
        const write = (key: string) => [{ table: "drafts" as const, key, value: "text" }];
        const first = credential("device-1");

        assert.isFalse(yield* storage.commit(write("before"), [], first.deviceId));
        yield* credentials.save(first);
        assert.isTrue(yield* storage.commit(write("during"), [], first.deviceId));
        assert.isFalse(yield* storage.commit(write("other"), [], deviceId("device-2")));

        assert.isTrue(Option.isNone(yield* credentials.clear(first, false)));
        assert.isFalse(yield* storage.commit(write("after"), [], first.deviceId));
        assert.deepStrictEqual([...(yield* storage.readAll("drafts")).keys()], ["during"]);
      }),
  );

  it.effect("keeps following the stored credential when saving a new one fails", () =>
    Effect.gen(function* () {
      let refusing = false;
      const { credentials, storage } = yield* makeDeviceStorage(
        memoryDatabase(),
        memorySecure(() => refusing),
        SERVER,
      );
      const write = [{ table: "drafts" as const, key: "k", value: "text" }];
      const first = credential("device-1");
      const second = credential("device-2");
      yield* credentials.save(first);

      refusing = true;
      const failed = yield* Effect.flip(credentials.save(second));
      assert.strictEqual(failed.operation, "save");
      assert.isFalse(yield* storage.commit(write, [], second.deviceId));
      assert.isTrue(yield* storage.commit(write, [], first.deviceId));
    }),
  );

  it.effect("clears a credential only if it is still the stored one", () =>
    Effect.gen(function* () {
      const { credentials, storage } = yield* makeDeviceStorage(
        memoryDatabase(),
        memorySecure(),
        SERVER,
      );
      const first = credential("device-1");
      const second = credential("device-2");
      yield* credentials.save(first);
      yield* credentials.save(second);

      const left = yield* credentials.clear(first, false);
      assert.strictEqual(Option.getOrNull(left)?.deviceId, second.deviceId);
      const write = [{ table: "drafts" as const, key: "k", value: "text" }];
      assert.isTrue(yield* storage.commit(write, [], second.deviceId));
    }),
  );

  it.effect("loads a credential kept without its copy, and then writes its records", () =>
    Effect.gen(function* () {
      // Secure storage outlived the database, as the iOS keychain outlives an
      // app that was removed and installed again.
      const secure = memorySecure();
      const first = credential("device-1");
      yield* (yield* makeDeviceStorage(memoryDatabase(), secure, SERVER)).credentials.save(first);
      const { credentials, storage } = yield* makeDeviceStorage(memoryDatabase(), secure, SERVER);

      const loaded = yield* credentials.load;
      assert.strictEqual(Option.getOrNull(loaded)?.deviceId, first.deviceId);
      const write = [{ table: "drafts" as const, key: "k", value: "text" }];
      assert.isTrue(yield* storage.commit(write, [], first.deviceId));
    }),
  );

  it.effect("never hands a server a credential another server issued", () =>
    Effect.gen(function* () {
      const secure = memorySecure();
      const database = memoryDatabase();
      yield* (yield* makeDeviceStorage(database, secure, SERVER)).credentials.save(
        credential("device-1"),
      );
      const elsewhere = yield* makeDeviceStorage(database, secure, "http://10.0.0.5:3737");
      assert.isTrue(Option.isNone(yield* elsewhere.credentials.load));
    }),
  );
});
