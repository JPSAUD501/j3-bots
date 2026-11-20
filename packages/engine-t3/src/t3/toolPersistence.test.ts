// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  type ItemRead,
  MAX_TOOL_READ_FAILURES,
  makeToolReads,
  persistenceOfRead,
  type ToolPersistence,
  toolReadBackoff,
} from "./toolPersistence.ts";

/** An input as `getTurnItem` returns it past 256 KiB: its text, cut, with the engine's marker. */
const cut = (text: string) => `${text}\n… output truncated for transport`;
const tool = (input: unknown): ItemRead => ({ _tag: "tool", input });

describe("persistenceOfRead", () => {
  it("reads the mark of an input the engine returned whole", () => {
    assert.strictEqual(
      persistenceOfRead(tool({ persistent: true, script: "x".repeat(20_000) })),
      "persistent",
    );
    assert.strictEqual(persistenceOfRead(tool("x".repeat(20_000))), "transient");
  });

  it("reads a cut input that opens no object as transient", () => {
    assert.strictEqual(persistenceOfRead(tool(cut("run the dev server …"))), "transient");
    assert.strictEqual(persistenceOfRead(tool(cut("[1,2,3"))), "transient");
  });

  // The cut text of an object and of a string that opens with an object's
  // text are the same: the engine's projection of its pending work decides.
  it("finds a cut input that opens an object undecidable, whatever it says", () => {
    assert.strictEqual(
      persistenceOfRead(tool(cut('{"persistent":true,"script":"x'))),
      "undecidable",
    );
    assert.strictEqual(
      persistenceOfRead(tool(cut('{"script":"x","persistent":false'))),
      "undecidable",
    );
  });

  it("finds an item that is no longer a dynamic tool transient", () => {
    assert.strictEqual(persistenceOfRead({ _tag: "not-a-tool" }), "transient");
  });
});

describe("makeToolReads", () => {
  it.effect("backs off after each failed read, and settles undecidable after the last", () =>
    Effect.gen(function* () {
      const reads = makeToolReads();
      let attempts = 0;
      const failing = Effect.suspend(() => {
        attempts++;
        return Effect.fail("timed out" as const);
      });
      const resolve = reads.resolve("session-1", "item-tool", failing);

      for (let failed = 1; failed < MAX_TOOL_READ_FAILURES; failed++) {
        assert.deepStrictEqual(yield* resolve, Option.none());
        assert.strictEqual(attempts, failed);
        // Asked again before its backoff passed, as on every catch-up: no read.
        assert.deepStrictEqual(yield* resolve, Option.none());
        assert.strictEqual(attempts, failed);
        yield* TestClock.adjust(toolReadBackoff(failed));
      }
      assert.deepStrictEqual(yield* resolve, Option.some<ToolPersistence>("undecidable"));
      assert.strictEqual(attempts, MAX_TOOL_READ_FAILURES);
      // Settled: it is not read again.
      assert.deepStrictEqual(yield* resolve, Option.some<ToolPersistence>("undecidable"));
      assert.strictEqual(attempts, MAX_TOOL_READ_FAILURES);
    }),
  );

  it.effect("keeps what a read learned until the tool is no longer live", () =>
    Effect.gen(function* () {
      const reads = makeToolReads();
      let attempts = 0;
      const reading = Effect.sync((): ToolPersistence => {
        attempts++;
        return "persistent";
      });
      assert.deepStrictEqual(
        yield* reads.resolve("session-1", "item-tool", reading),
        Option.some<ToolPersistence>("persistent"),
      );
      yield* reads.resolve("session-1", "item-tool", reading);
      assert.strictEqual(attempts, 1);

      // The latest view shows it ended: what was learned goes.
      yield* reads.prune("session-1", 3, () => true);
      yield* reads.resolve("session-1", "item-tool", reading);
      assert.strictEqual(attempts, 2);
    }),
  );

  // Each reader of the session shares the tool's read: one at a time.
  it.effect("starts no second read of a tool while one runs, whatever a stale view shows", () =>
    Effect.gen(function* () {
      const reads = makeToolReads();
      let exports = 0;
      const exporting = (done: Deferred.Deferred<void>) =>
        Effect.suspend(() => {
          exports++;
          return Deferred.await(done).pipe(Effect.as<ToolPersistence>("transient"));
        });
      const resolve = (read: Effect.Effect<ToolPersistence>) =>
        reads.resolve("session-1", "item-tool", read);

      const firstDone = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(resolve(exporting(firstDone)));
      yield* Effect.yieldNow;
      assert.strictEqual(exports, 1);

      // The latest view has the tool live; an older one, from before it was
      // reopened, has it ended. Only the latest prunes.
      yield* reads.prune("session-1", 10, () => false);
      yield* reads.prune("session-1", 9, () => true);
      assert.deepStrictEqual(yield* resolve(exporting(firstDone)), Option.none());
      assert.strictEqual(exports, 1);

      // It ends, and is reopened: a second read claims it.
      yield* reads.prune("session-1", 11, () => true);
      const secondDone = yield* Deferred.make<void>();
      const second = yield* Effect.forkChild(resolve(exporting(secondDone)));
      yield* Effect.yieldNow;
      assert.strictEqual(exports, 2);

      // The first read ends: it changes only the entry it claimed, which is
      // gone, so the second read still runs alone.
      yield* Deferred.succeed(firstDone, undefined);
      assert.deepStrictEqual(yield* Fiber.join(first), Option.some<ToolPersistence>("transient"));
      assert.deepStrictEqual(yield* resolve(exporting(secondDone)), Option.none());
      assert.strictEqual(exports, 2);

      yield* Deferred.succeed(secondDone, undefined);
      yield* Fiber.join(second);
    }),
  );
});
