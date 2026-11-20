// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { persistenceInItem, resolvePersistence, type WholeInput } from "./toolPersistence.ts";

/** An input as `getTurnItem` returns it past 256 KiB: its JSON text, cut, with the engine's marker. */
const cut = (text: string) => `${text}\n… output truncated for transport`;

describe("persistenceInItem", () => {
  it("reads a top-level mark the engine's cut left whole", () => {
    const script = "x".repeat(300_000);
    assert.deepStrictEqual(
      persistenceInItem(cut(`{"name":"dev","persistent":true,"script":"${script.slice(0, 100)}`)),
      Option.some("persistent"),
    );
    assert.deepStrictEqual(
      persistenceInItem(cut(`{"persistent":false,"script":"${script.slice(0, 100)}`)),
      Option.some("transient"),
    );
    // Members before it are skipped whole, nested marks and strings included.
    assert.deepStrictEqual(
      persistenceInItem(
        cut('{"env":{"persistent":true},"args":["a\\"}",1],"note":"{\\"persistent\\":true}",'),
      ),
      Option.none(),
    );
    assert.deepStrictEqual(
      persistenceInItem(cut('{"env":{"persistent":true},"args":[1,2],"persistent":true,"x":"')),
      Option.some("persistent"),
    );
  });

  it("leaves the mark to a fuller read when the cut came before it, or inside it", () => {
    assert.deepStrictEqual(persistenceInItem(cut('{"script":"xxxx')), Option.none());
    assert.deepStrictEqual(persistenceInItem(cut('{"script":"x","persistent":tr')), Option.none());
    assert.deepStrictEqual(persistenceInItem(cut('{"script":"x","persis')), Option.none());
  });

  it("reads a cut input that opens no object as transient", () => {
    assert.deepStrictEqual(
      persistenceInItem(cut("run the dev server …")),
      Option.some("transient"),
    );
    assert.deepStrictEqual(persistenceInItem(cut("[1,2,3")), Option.some("transient"));
  });
});

describe("resolvePersistence", () => {
  const hidden = cut(`{"script":"${"x".repeat(1_000)}`);
  const whole = (input: WholeInput) => Effect.succeed(input);

  it.effect("reads the transcript when the item's cut hides the mark", () =>
    Effect.gen(function* () {
      const persistent = yield* resolvePersistence({
        item: Effect.succeed(hidden),
        whole: whole({ _tag: "found", input: { script: "x", persistent: true } }),
      });
      assert.strictEqual(persistent, "persistent");
      const transient = yield* resolvePersistence({
        item: Effect.succeed(hidden),
        whole: whole({ _tag: "found", input: { script: "x" } }),
      });
      assert.strictEqual(transient, "transient");
    }),
  );

  it.effect("finds it undecidable only when the transcript is past its export limit", () =>
    Effect.gen(function* () {
      const persistence = yield* resolvePersistence({
        item: Effect.succeed(hidden),
        whole: whole({ _tag: "unavailable" }),
      });
      assert.strictEqual(persistence, "undecidable");
    }),
  );

  it.effect("fails, to be read again, when the transcript could not be read", () =>
    Effect.gen(function* () {
      const read = yield* resolvePersistence({
        item: Effect.succeed(hidden),
        whole: Effect.fail("unreachable" as const),
      }).pipe(Effect.option);
      assert.deepStrictEqual(read, Option.none());
    }),
  );
});
