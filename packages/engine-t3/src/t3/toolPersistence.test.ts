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
  persistenceInItem,
  resolvePersistence,
  type ToolPersistence,
  toolReadBackoff,
  type WholeInput,
} from "./toolPersistence.ts";

/** An input as `getTurnItem` returns it past 256 KiB: its text, cut, with the engine's marker. */
const cut = (text: string) => `${text}\n… output truncated for transport`;

describe("persistenceInItem", () => {
  it("reads the mark of an input the engine returned whole", () => {
    assert.deepStrictEqual(
      persistenceInItem({ persistent: true, script: "x".repeat(20_000) }),
      Option.some("persistent"),
    );
    assert.deepStrictEqual(persistenceInItem("x".repeat(20_000)), Option.some("transient"));
  });

  it("reads a cut input that opens no object as transient", () => {
    assert.deepStrictEqual(
      persistenceInItem(cut("run the dev server …")),
      Option.some("transient"),
    );
    assert.deepStrictEqual(persistenceInItem(cut("[1,2,3")), Option.some("transient"));
  });

  // The cut text of an object and of a string that opens with an object's
  // text are the same: only the transcript tells them apart.
  it("leaves a cut input that opens an object to the transcript, whatever it says", () => {
    assert.deepStrictEqual(persistenceInItem(cut('{"persistent":true,"script":"x')), Option.none());
    assert.deepStrictEqual(
      persistenceInItem(cut('{"script":"x","persistent":false')),
      Option.none(),
    );
  });
});

describe("resolvePersistence", () => {
  const item = (input: unknown) => Effect.succeed<ItemRead>({ _tag: "tool", input });
  const whole = (input: WholeInput) => Effect.succeed(input);

  it.effect("reads the transcript when the item's cut leaves the mark unknown", () =>
    Effect.gen(function* () {
      const hidden = item(cut('{"script":"x'));
      const persistent = yield* resolvePersistence({
        item: hidden,
        whole: whole({ _tag: "found", input: { script: "x", persistent: true } }),
      });
      assert.strictEqual(persistent, "persistent");
      const transient = yield* resolvePersistence({
        item: hidden,
        whole: whole({ _tag: "found", input: { script: "x" } }),
      });
      assert.strictEqual(transient, "transient");
    }),
  );

  // A string is never persistent, though its cut text opens with a mark.
  it.effect("finds a string input that reads as a persistent object transient", () =>
    Effect.gen(function* () {
      const text = `{"persistent":true,"script":"${"x".repeat(300_000)}"}`;
      const persistence = yield* resolvePersistence({
        item: item(cut(text.slice(0, 1_000))),
        whole: whole({ _tag: "found", input: text }),
      });
      assert.strictEqual(persistence, "transient");
    }),
  );

  it.effect("finds it undecidable when the transcript is past its export limit", () =>
    Effect.gen(function* () {
      const persistence = yield* resolvePersistence({
        item: item(cut('{"script":"x')),
        whole: whole({ _tag: "unavailable" }),
      });
      assert.strictEqual(persistence, "undecidable");
    }),
  );

  it.effect("finds an item that is no longer a dynamic tool transient", () =>
    Effect.gen(function* () {
      const persistence = yield* resolvePersistence({
        item: Effect.succeed<ItemRead>({ _tag: "not-a-tool" }),
        whole: Effect.die("not read"),
      });
      assert.strictEqual(persistence, "transient");
    }),
  );
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

  // A transcript read exports the whole thread: a second one at once could
  // stall the engine's other readers.
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
