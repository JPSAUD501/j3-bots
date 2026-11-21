// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DeviceCredential, Platform } from "@j3-bots/client-runtime";
import { DeviceId, DeviceToken } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { memoryDatabase, memorySecure } from "./platform/memoryStorage.ts";
import {
  forgetPairing,
  makeDeviceStorage,
  type SecureValue,
  type SqlDatabase,
  storedServer,
} from "./platform/storage.ts";
import { makeSession } from "./session.ts";

const credential: DeviceCredential = {
  deviceId: Schema.decodeSync(DeviceId)("device-1"),
  token: Redacted.make(
    Schema.decodeSync(DeviceToken)("device-1-a-token-long-enough-for-the-schema"),
  ),
};

/** None of these tests reaches a server, so none starts a client. */
const noClient = (): Layer.Layer<Platform> =>
  Layer.effectContext(Effect.die("These tests start no client."));

const sessionOver = (database: SqlDatabase, secure: SecureValue) =>
  makeSession({
    storedServer: storedServer(secure),
    forget: forgetPairing(database, secure),
    makePlatform: noClient,
  });

/** A device paired with `server`, with a draft of that pairing. */
const paired = (server: string) =>
  Effect.gen(function* () {
    const database = memoryDatabase();
    const secure = memorySecure();
    const { credentials, storage } = makeDeviceStorage(database, secure, server);
    yield* credentials.save(credential);
    const draft = [{ table: "drafts" as const, key: "bot:a", value: "text" }];
    assert.isTrue(yield* storage.commit(draft, [], credential.deviceId));
    return { database, secure, storage };
  });

describe("the app's session", () => {
  it.effect("shows a stored credential that does not decode as unreadable, not as unpaired", () =>
    Effect.gen(function* () {
      const session = sessionOver(memoryDatabase(), memorySecure({ held: "{damaged" }));
      yield* Effect.promise(session.start);
      assert.strictEqual(session.state.get()._tag, "unreadable");
    }),
  );

  it.effect("forgets a sign-in it cannot read, with its records, and then shows pairing", () =>
    Effect.gen(function* () {
      const { database, secure, storage } = yield* paired("http://192.168.1.20:3737");
      yield* Effect.promise(() => secure.set("{damaged"));
      const session = sessionOver(database, secure);
      yield* Effect.promise(session.start);

      assert.isTrue(yield* Effect.promise(session.forget));
      assert.strictEqual(session.state.get()._tag, "none");
      assert.isNull(yield* Effect.promise(secure.get));
      assert.strictEqual((yield* storage.readAll("drafts")).size, 0);
    }),
  );

  it.effect("forgets a pairing whose saved server the app no longer accepts", () =>
    Effect.gen(function* () {
      // Plain HTTP to a public host, which the pairing screen refuses.
      const { database, secure, storage } = yield* paired("http://bots.example.com");
      const session = sessionOver(database, secure);
      yield* Effect.promise(session.start);

      assert.strictEqual(session.state.get()._tag, "none");
      assert.isTrue(Option.isNone(yield* storedServer(secure)));
      assert.strictEqual((yield* storage.readAll("drafts")).size, 0);
      const write = [{ table: "drafts" as const, key: "k", value: "text" }];
      assert.isFalse(yield* storage.commit(write, [], credential.deviceId));
    }),
  );
});
