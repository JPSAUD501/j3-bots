// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import { fileFailure, whileHeld } from "./heldFiles.ts";

/** An operation that fails with `code` its first `failures` times, counting its attempts. */
const failingFirst = Effect.fn(function* (code: string, failures: number) {
  const attempts = yield* Ref.make(0);
  const operation = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
    Effect.filterOrFail(
      (count) => count > failures,
      () => ({ code }),
    ),
  );
  return { attempts, operation };
});

const codeOf = (error: { readonly code: string }) => error.code;

describe("whileHeld", () => {
  it.live("tries a rename Windows refuses while a file is held again until it goes through", () =>
    Effect.gen(function* () {
      for (const code of ["EBUSY", "EPERM", "EACCES"]) {
        const { attempts, operation } = yield* failingFirst(code, 3);
        yield* whileHeld(operation, { platform: "win32", codeOf });
        assert.strictEqual(yield* Ref.get(attempts), 4, code);
      }
    }),
  );

  it.live("gives up after its patience, with the last failure", () =>
    Effect.gen(function* () {
      const { operation } = yield* failingFirst("EBUSY", Number.POSITIVE_INFINITY);
      const exit = yield* whileHeld(operation, {
        platform: "win32",
        codeOf,
        patience: "300 millis",
      }).pipe(Effect.exit);
      assert.deepStrictEqual(exit, Exit.fail({ code: "EBUSY" }));
    }),
  );

  it.live("fails at once for any other failure, and on any other system", () =>
    Effect.gen(function* () {
      for (const [platform, code] of [
        ["win32", "ENOSPC"],
        ["linux", "EBUSY"],
      ] as const) {
        const { attempts, operation } = yield* failingFirst(code, 1);
        const exit = yield* whileHeld(operation, { platform, codeOf }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(yield* Ref.get(attempts), 1);
      }
    }),
  );
});

describe("fileFailure", () => {
  it("says the disk is full only when the system said so", () => {
    const on = (code: string | null, moves = false) =>
      fileFailure(code, { platform: "win32", moves });
    assert.strictEqual(on("ENOSPC"), "storage");
    assert.strictEqual(on("EDQUOT"), "storage");
    assert.strictEqual(on("EBUSY"), "in-use");
    // Windows refuses a move of a held file with these too, and a write where it may not.
    assert.strictEqual(on("EPERM", true), "in-use");
    assert.strictEqual(on("EPERM"), "permission");
    assert.strictEqual(on("EACCES"), "permission");
    assert.strictEqual(fileFailure("EPERM", { platform: "linux", moves: true }), "permission");
    assert.strictEqual(on("ENAMETOOLONG"), "files");
    assert.strictEqual(on(null), "files");
  });
});
