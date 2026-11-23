// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  compareVersions,
  decideStart,
  readRuntimeRecord,
  type RecordedRuntime,
  recordPending,
  recordReady,
  recordTransitioned,
  type RuntimeRecord,
  setAsideRecord,
  type StartDecision,
  type StartFacts,
} from "./record.ts";

const recorded = (
  version: string,
  more: Pick<RuntimeRecord, "rollback" | "pending"> = {},
): RecordedRuntime => ({
  _tag: "recorded",
  record: { schema: 1, version, readyAt: DateTime.makeUnsafe("2026-11-23T00:00:00Z"), ...more },
});

const pendingTo = (to: string) => ({
  pending: { from: { version: "0.2.0" }, to: { version: to }, snapshot: "s" },
});

describe("whether a release may start on a home", () => {
  const table: ReadonlyArray<
    readonly [description: string, facts: Partial<StartFacts>, decision: StartDecision]
  > = [
    ["a home no release recorded", { recorded: { _tag: "none" } }, "start"],
    ["the release recorded", { recorded: recorded("0.3.0") }, "start"],
    ["a newer release", { recorded: recorded("0.2.0") }, "snapshot-then-start"],
    [
      "a release after its pre-release",
      { recorded: recorded("0.3.0-rc.2") },
      "snapshot-then-start",
    ],
    [
      "an older release whose newer one is kept",
      { recorded: recorded("0.3.1"), kept: ["0.3.0", "0.3.1"] },
      "refuse-downgrade",
    ],
    [
      "an older release, the newer one recorded not on this computer",
      { recorded: recorded("0.4.0"), kept: ["0.3.0"] },
      "refuse-unknown-schema",
    ],
    ["a record it cannot read", { recorded: { _tag: "unreadable" } }, "refuse-unknown-schema"],
    [
      "a version that cannot be ordered against the recorded one",
      { recorded: recorded("nightly") },
      "refuse-unknown-schema",
    ],
    [
      "another build of the recorded version",
      { recorded: recorded("0.3.0+a"), starting: "0.3.0+b" },
      "refuse-unknown-schema",
    ],
    [
      "a newer release, the version recorded not one releases are numbered with",
      { recorded: recorded("nightly-2026-11-23"), starting: "0.4.0" },
      "refuse-unknown-schema",
    ],
    [
      "the release a rollback was made from",
      { recorded: recorded("0.2.0", { rollback: { from: "0.3.0" } }) },
      "refuse-rolled-back",
    ],
    [
      "a release newer than the one a rollback was made from",
      { recorded: recorded("0.2.0", { rollback: { from: "0.3.0" } }), starting: "0.3.1" },
      "snapshot-then-start",
    ],
    [
      "the release rolled back to",
      { recorded: recorded("0.2.0", { rollback: { from: "0.3.0" } }), starting: "0.2.0" },
      "start",
    ],
    [
      "the release a transition cut off was moving to",
      { recorded: recorded("0.2.0", pendingTo("0.3.0")) },
      "snapshot-then-start",
    ],
    [
      "a newer release than the one a transition cut off was moving to",
      { recorded: recorded("0.2.0", pendingTo("0.3.0")), starting: "0.3.1" },
      "snapshot-then-start",
    ],
    [
      "the release a transition cut off started from, on data it may have migrated",
      { recorded: recorded("0.2.0", pendingTo("0.3.0")), starting: "0.2.0" },
      "refuse-unknown-schema",
    ],
    [
      "the release an unfinished rollback ends on, older than the one recorded",
      {
        recorded: recorded("0.3.1"),
        kept: ["0.3.0", "0.3.1"],
        rollingBackTo: Option.some("0.3.0"),
      },
      "start",
    ],
    [
      "the recorded release while a rollback to another has not finished",
      { recorded: recorded("0.3.0"), rollingBackTo: Option.some("0.2.0") },
      "refuse-unknown-schema",
    ],
  ];
  for (const [description, facts, decision] of table) {
    it(`${decision} for ${description}`, () => {
      assert.strictEqual(
        decideStart({
          recorded: { _tag: "none" },
          starting: "0.3.0",
          kept: ["0.3.0"],
          rollingBackTo: Option.none(),
          ...facts,
        }),
        decision,
      );
    });
  }

  it("orders two builds of one version as equal, and a version that is not one as nothing", () => {
    assert.deepStrictEqual(compareVersions("0.3.0+a", "0.3.0+b"), Option.some(0));
    assert.deepStrictEqual(compareVersions("0.3.0+a", "0.3.1"), Option.some(-1));
    assert.isTrue(Option.isNone(compareVersions("nightly", "0.3.0")));
    assert.isTrue(Option.isNone(compareVersions("0.3", "0.3.0")));
  });

  it("orders versions as releases are numbered", () => {
    const ordered = [
      "0.2.9",
      "0.3.0-alpha",
      "0.3.0-alpha.1",
      "0.3.0-beta",
      "0.3.0-rc.2",
      "0.3.0-rc.10",
      "0.3.0",
      "0.10.0",
      "1.0.0",
    ];
    for (const [index, version] of ordered.entries()) {
      for (const [other, than] of ordered.entries()) {
        assert.deepStrictEqual(
          compareVersions(version, than),
          Option.some(Math.sign(index - other)),
          `${version} against ${than}`,
        );
      }
    }
  });
});

it.layer(NodeServices.layer)("a home's record", (it) => {
  const homeWith = Effect.fn(function* (text: Option.Option<string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    if (Option.isSome(text)) {
      yield* fs.makeDirectory(path.join(home, "state"));
      yield* fs.writeFileString(path.join(home, "state", "runtime.json"), text.value);
    }
    return home;
  });

  it.effect("is none on a home without one, and reads back what was recorded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* homeWith(Option.none());
      assert.strictEqual((yield* readRuntimeRecord(home))._tag, "none");
      yield* recordTransitioned(home, "0.3.0", Option.some("0.3.1"));
      const back = yield* readRuntimeRecord(home);
      assert.strictEqual(back._tag, "recorded");
      if (back._tag !== "recorded") return;
      assert.strictEqual(back.record.version, "0.3.0");
      assert.deepStrictEqual(back.record.rollback, { from: "0.3.1" });
      const file = path.join(home, "state", "runtime.json");
      assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
      // Starting the release rolled back to again keeps the rollback, so 0.3.1 is not retried.
      yield* recordReady(home, "0.3.0");
      const again = yield* readRuntimeRecord(home);
      assert.isTrue(again._tag === "recorded" && again.record.rollback?.from === "0.3.1");
      yield* recordReady(home, "0.3.1");
      const ready = yield* readRuntimeRecord(home);
      assert.isTrue(ready._tag === "recorded" && ready.record.rollback === undefined);
    }),
  );

  it.effect("is unreadable when damaged, or written in a newer format", () =>
    Effect.gen(function* () {
      for (const text of [
        "{",
        '{"schema":2,"version":"0.4.0","readyAt":"2026-11-23T00:00:00.000Z"}',
      ]) {
        const home = yield* homeWith(Option.some(text));
        assert.strictEqual((yield* readRuntimeRecord(home))._tag, "unreadable", text);
      }
    }),
  );

  it.effect("names a transition pending from the release that ran, until it is recorded", () =>
    Effect.gen(function* () {
      const home = yield* homeWith(Option.none());
      const pending = { from: { version: "0.3.0" }, to: { version: "0.3.1" }, snapshot: "s" };
      yield* recordPending(home, pending);
      const during = yield* readRuntimeRecord(home);
      assert.isTrue(during._tag === "recorded" && during.record.version === "0.3.0");
      assert.deepStrictEqual(
        during._tag === "recorded" ? during.record.pending : undefined,
        pending,
      );
      yield* recordTransitioned(home, "0.3.1", Option.none());
      const after = yield* readRuntimeRecord(home);
      assert.isTrue(after._tag === "recorded" && after.record.pending === undefined);
    }),
  );

  it.effect("can be set aside when unreadable, kept beside it, so the home starts again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* homeWith(Option.some("{"));
      assert.strictEqual((yield* readRuntimeRecord(home))._tag, "unreadable");
      yield* setAsideRecord(home);
      assert.strictEqual((yield* readRuntimeRecord(home))._tag, "none");
      const kept = (yield* fs.readDirectory(path.join(home, "state"))).filter((name) =>
        name.startsWith("runtime.json.unreadable-"),
      );
      assert.lengthOf(kept, 1);
      assert.strictEqual(yield* fs.readFileString(path.join(home, "state", kept[0] ?? "")), "{");
    }),
  );

  it.effect("reads a newer release's record that only adds to it", () =>
    Effect.gen(function* () {
      const home = yield* homeWith(
        Option.some(
          '{"schema":1,"version":"0.4.0","readyAt":"2026-11-23T00:00:00.000Z","added":true}',
        ),
      );
      const read = yield* readRuntimeRecord(home);
      assert.isTrue(read._tag === "recorded" && read.record.version === "0.4.0");
    }),
  );
});
