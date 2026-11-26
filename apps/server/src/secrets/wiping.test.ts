// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the test wraps node:crypto's scrypt, which an old vault's password goes through.
import type * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Domain from "../domain.ts";
import * as TestDomain from "../testing/domain.ts";
import { OLD_VAULT_PASSWORD, oldVault } from "../testing/secrets.ts";
import { afterEach, vi } from "vite-plus/test";
import { Secrets } from "./Secrets.ts";

/** Every key scrypt derived, and who waits for the next derivation to start. */
const scrypt = vi.hoisted(() => ({
  keys: new Array<Buffer>(),
  started: new Array<() => void>(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    scrypt: (
      password: NodeCrypto.BinaryLike,
      salt: NodeCrypto.BinaryLike,
      keylen: number,
      options: NodeCrypto.ScryptOptions,
      callback: (error: Error | null, key: Buffer) => void,
    ) => {
      for (const notify of scrypt.started.splice(0)) notify();
      actual.scrypt(password, salt, keylen, options, (error, key) => {
        scrypt.keys.push(key);
        callback(error, key);
      });
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  scrypt.keys.length = 0;
});

const WRONG = Redacted.make("incorrect horse battery");

const zeroed = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

/** The state the secrets are in now. */
const stateNow = Effect.gen(function* () {
  const status = yield* Stream.runHead((yield* Secrets).status);
  return Option.getOrThrow(status).state;
});

/** A server over a home with a vault from before secrets, holding a login. */
const overOldVault = <A, E>(use: Effect.Effect<A, E, Secrets>) =>
  Effect.gen(function* () {
    yield* oldVault([
      { id: "cred_0000000000000001", label: "Example", password: "hunter2", bots: [] },
    ]);
    scrypt.keys.length = 0;
    return yield* use.pipe(Effect.provide(Domain.layer));
  }).pipe(Effect.provide(Layer.fresh(TestDomain.machine)));

it.effect(
  "leaves no key it derived from the old vault's password in memory, and logs neither password",
  () => {
    const logged: Array<string> = [];
    return overOldVault(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        yield* Effect.exit(secrets.openOldVault(WRONG));
        yield* secrets.openOldVault(OLD_VAULT_PASSWORD);
        assert.strictEqual(yield* stateNow, "ready");

        // The wrong password and the right one.
        assert.strictEqual(scrypt.keys.length, 2);
        assert.isTrue(scrypt.keys.every(zeroed));
        const logs = logged.join("\n");
        assert.notInclude(logs, Redacted.value(WRONG));
        assert.notInclude(logs, Redacted.value(OLD_VAULT_PASSWORD));
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.map(Logger.formatJson, (line) => {
              logged.push(line);
            }),
          ]),
        ),
      ),
    );
  },
);

it.effect("zeroes the key of an opening interrupted while scrypt derives it", () =>
  overOldVault(
    Effect.gen(function* () {
      const secrets = yield* Secrets;
      const started = new Promise<void>((resolve) => scrypt.started.push(resolve));
      const opening = yield* Effect.forkChild(secrets.openOldVault(OLD_VAULT_PASSWORD));
      yield* Effect.promise(() => started);
      assert.isEmpty(scrypt.keys);
      yield* Fiber.interrupt(opening);

      assert.strictEqual(scrypt.keys.length, 1);
      assert.isTrue(scrypt.keys.every(zeroed));
      assert.strictEqual(yield* stateNow, "old-vault");
    }),
  ),
);
