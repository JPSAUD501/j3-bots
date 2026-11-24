// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the test wraps node:crypto's scrypt, which the vault uses.
import type * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestDomain from "../testing/domain.ts";
import { afterEach, vi } from "vite-plus/test";
import { Vault } from "./Vault.ts";

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

const PASSWORD = Redacted.make("correct horse battery");
const WRONG = Redacted.make("incorrect horse battery");

const zeroed = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

/** Every buffer `Buffer.concat` joins or gives from now on: decrypting puts a plaintext together with it. */
const recordConcat = () => {
  const seen: Array<Uint8Array> = [];
  const concat = Buffer.concat.bind(Buffer);
  vi.spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
    const joined = concat(list, totalLength);
    seen.push(...list, joined);
    return joined;
  });
  return seen;
};

it.effect("leaves no key it derived or unwrapped in memory once the vault is locked", () =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    yield* vault.setup(PASSWORD);
    yield* vault.lock;
    const joined = recordConcat();
    yield* Effect.exit(vault.unlock(WRONG));
    yield* vault.unlock(PASSWORD);
    yield* vault.lock;

    // Set up, the wrong password and the right one.
    assert.strictEqual(scrypt.keys.length, 3);
    assert.isTrue(scrypt.keys.every(zeroed));
    assert.isNotEmpty(joined);
    assert.isTrue(joined.every(zeroed));
  }).pipe(Effect.provide(TestDomain.layer)),
);

it.effect("zeroes the key of an unlock interrupted while scrypt derives it", () =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    yield* vault.setup(PASSWORD);
    yield* vault.lock;
    scrypt.keys.length = 0;

    const started = new Promise<void>((resolve) => scrypt.started.push(resolve));
    const unlocking = yield* Effect.forkChild(vault.unlock(PASSWORD));
    yield* Effect.promise(() => started);
    assert.isEmpty(scrypt.keys);
    yield* Fiber.interrupt(unlocking);

    assert.strictEqual(scrypt.keys.length, 1);
    assert.isTrue(scrypt.keys.every(zeroed));
    const status = Option.getOrThrow(yield* Stream.runHead(vault.status));
    assert.strictEqual(status.state, "locked");
  }).pipe(Effect.provide(TestDomain.layer)),
);
