// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { stopsWork } from "./update.ts";

/** An operator who would answer `answer`, and the questions put to them. */
const operator = (answer: boolean) => {
  const asked: Array<Option.Option<number>> = [];
  return {
    asked,
    ask: (count: Option.Option<number>) =>
      Effect.sync(() => {
        asked.push(count);
        return answer;
      }),
  };
};

it.effect("stops work that began after a client asked only if the client said so", () =>
  Effect.gen(function* () {
    // The unit's command gives no `--yes`, but a script might: the run's answer stands.
    const kept = operator(true);
    assert.isFalse(
      yield* stopsWork(Option.some({ stopWork: false }), true, kept.ask)(Option.some(1)),
    );
    const stopped = operator(false);
    assert.isTrue(
      yield* stopsWork(Option.some({ stopWork: true }), false, stopped.ask)(Option.none()),
    );
    assert.deepStrictEqual([...kept.asked, ...stopped.asked], []);
  }),
);

it.effect("asks the operator in a shell unless --yes answers", () =>
  Effect.gen(function* () {
    const shell = operator(false);
    assert.isFalse(yield* stopsWork(Option.none(), false, shell.ask)(Option.some(3)));
    assert.deepStrictEqual(shell.asked, [Option.some(3)]);
    const script = operator(false);
    assert.isTrue(yield* stopsWork(Option.none(), true, script.ask)(Option.some(3)));
    assert.deepStrictEqual(script.asked, []);
  }),
);
