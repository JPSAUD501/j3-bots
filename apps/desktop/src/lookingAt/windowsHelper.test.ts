// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { residentHelper } from "./windowsHelper.ts";

/**
 * A helper as the app meets one: it answers each ask with the window it
 * names, the latest ask first, so answers come back out of order; and it
 * ends on a picture of window 0.
 */
const HELPER = `
const lines = require("node:readline").createInterface({ input: process.stdin });
const held = [];
lines.on("line", (line) => {
  const { id, ask } = JSON.parse(line);
  if (ask.op === "picture" && ask.window === 0) process.exit(0);
  held.push({ id, answer: ask.op === "front" ? { window: ask.own } : String(ask.window) });
  if (held.length < 2) return;
  for (const answer of held.splice(0).reverse()) process.stdout.write(JSON.stringify(answer) + "\\n");
});
`;

const helper = residentHelper({
  command: process.execPath,
  args: ["-e", HELPER],
  idleFor: Duration.minutes(1),
});
const within = Duration.seconds(5);

describe("the helper that reads windows on Windows", () => {
  it.live("gives each ask its own answer, whichever comes first", () =>
    Effect.gen(function* () {
      const ask = yield* helper;
      const [front, picture] = yield* Effect.all(
        [
          ask({ op: "front", own: 7, title: true }, within),
          ask({ op: "picture", window: 9 }, within),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(front, { window: 7 });
      assert.strictEqual(picture, "9");
    }).pipe(Effect.scoped),
  );

  it.live("answers nothing when the helper ends, and starts it again on the next ask", () =>
    Effect.gen(function* () {
      const ask = yield* helper;
      assert.isNull(yield* ask({ op: "picture", window: 0 }, within));
      const [front, picture] = yield* Effect.all(
        [
          ask({ op: "front", own: 3, title: false }, within),
          ask({ op: "picture", window: 4 }, within),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(front, { window: 3 });
      assert.strictEqual(picture, "4");
    }).pipe(Effect.scoped),
  );
});
