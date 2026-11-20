// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { toolInputDigest } from "./toolCaller.ts";

describe("toolInputDigest", () => {
  it.effect("gives equal inputs one digest whatever the order of their keys", () =>
    Effect.gen(function* () {
      const recorded = yield* toolInputDigest({ text: "Hi", options: { a: 1, b: [2, 3] } });
      const received = yield* toolInputDigest({ options: { b: [2, 3], a: 1 }, text: "Hi" });
      const other = yield* toolInputDigest({ text: "Hi", options: { a: 1, b: [3, 2] } });

      assert.strictEqual(received, recorded);
      assert.notStrictEqual(other, recorded);
      assert.strictEqual(yield* toolInputDigest(undefined), yield* toolInputDigest({}));
    }),
  );
});
