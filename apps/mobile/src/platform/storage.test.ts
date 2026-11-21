// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceCredential } from "@j3-bots/client-runtime";
import { DeviceId, DeviceToken } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { memoryDatabase, memorySecure } from "./memoryStorage.ts";
import { makeDeviceStorage, type SqlDatabase, storedServer } from "./storage.ts";

const SERVER = "http://192.168.1.20:3737";

const credential = (id: string): DeviceCredential => ({
  deviceId: Schema.decodeSync(DeviceId)(id),
  token: Redacted.make(Schema.decodeSync(DeviceToken)(`${id}-a-token-long-enough-for-the-schema`)),
});

const deviceId = (id: string) => Schema.decodeSync(DeviceId)(id);

describe("the app's storage", () => {
  it.effect("moves a record in one transaction, only while what it expects still holds", () =>
    Effect.gen(function* () {
      const { storage } = makeDeviceStorage(memoryDatabase(), memorySecure(), SERVER);
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
        const { credentials, storage } = makeDeviceStorage(
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
      const { credentials, storage } = makeDeviceStorage(
        memoryDatabase(),
        memorySecure({ failing: () => refusing }),
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
      const { credentials, storage } = makeDeviceStorage(memoryDatabase(), memorySecure(), SERVER);
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
      yield* makeDeviceStorage(memoryDatabase(), secure, SERVER).credentials.save(first);
      const { credentials, storage } = makeDeviceStorage(memoryDatabase(), secure, SERVER);

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
      yield* makeDeviceStorage(database, secure, SERVER).credentials.save(credential("device-1"));
      const elsewhere = makeDeviceStorage(database, secure, "http://10.0.0.5:3737");
      assert.isTrue(Option.isNone(yield* elsewhere.credentials.load));
    }),
  );

  it.effect(
    "takes a stored credential that does not decode for damaged storage, not for none",
    () =>
      Effect.gen(function* () {
        const secure = memorySecure({ held: "{not a credential" });
        const { credentials } = makeDeviceStorage(memoryDatabase(), secure, SERVER);

        assert.strictEqual((yield* Effect.flip(storedServer(secure))).operation, "load");
        assert.strictEqual((yield* Effect.flip(credentials.load)).operation, "load");
      }),
  );

  it.effect("runs the writes of two storages one after the other", () =>
    Effect.gen(function* () {
      // Counts the transactions open at once, each held open across a turn
      // of the event loop, where another could start.
      const inner = memoryDatabase();
      let open = 0;
      let most = 0;
      const database: SqlDatabase = {
        transaction: async (work) => {
          open += 1;
          most = Math.max(most, open);
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return await inner.transaction(work);
          } finally {
            open -= 1;
          }
        },
      };
      const secure = memorySecure();
      const leaving = makeDeviceStorage(database, secure, SERVER);
      const starting = makeDeviceStorage(database, secure, SERVER);

      yield* Effect.all(
        [leaving.storage.write("drafts", "a", "one"), starting.storage.write("drafts", "b", "two")],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(most, 1);
      assert.deepStrictEqual(
        [...(yield* starting.storage.readAll("drafts"))],
        [
          ["a", "one"],
          ["b", "two"],
        ],
      );
    }),
  );
});
