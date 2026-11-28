// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { makeInputHold, type StoppableInput } from "./hold.ts";

/** A view's input, as the hold sees it: `send` reports whether the event was stopped. */
const view = () => {
  let dropper: ((event: StoppableInput) => void) | null = null;
  const holding = makeInputHold((drop) => {
    dropper = drop;
  });
  const send = () => {
    let stopped = false;
    dropper?.({
      preventDefault: () => {
        stopped = true;
      },
    });
    return stopped;
  };
  return { holding, send };
};

describe("the hold on the person's input during a fill", () => {
  it.effect("stops their input only while a hold runs, however it ends", () =>
    Effect.gen(function* () {
      const { holding, send } = view();
      assert.isFalse(send());
      assert.isTrue(yield* holding(Effect.sync(send)));
      assert.isFalse(send());
      const failed = yield* Effect.exit(holding(Effect.fail("the fill failed")));
      assert.isTrue(Exit.isFailure(failed));
      assert.isFalse(send());
    }),
  );

  it.effect("lasts until the last of two holds ends", () =>
    Effect.gen(function* () {
      const { holding, send } = view();
      const inner = yield* holding(Effect.andThen(holding(Effect.void), Effect.sync(send)));
      assert.isTrue(inner);
      assert.isFalse(send());
    }),
  );
});
