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
  recordReady,
  type StartDecision,
  type StartFacts,
  writeRuntimeRecord,
} from "./record.ts";

const recorded = (version: string): RecordedRuntime => ({
  _tag: "recorded",
  record: { schema: 1, version, readyAt: DateTime.makeUnsafe("2026-11-23T00:00:00Z") },
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
      { recorded: recorded("0.3.0+build.1"), starting: "0.3.0+build.2" },
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
      yield* writeRuntimeRecord(home, "0.3.0", Option.some("0.3.1"));
      const back = yield* readRuntimeRecord(home);
      assert.strictEqual(back._tag, "recorded");
      if (back._tag !== "recorded") return;
      assert.strictEqual(back.record.version, "0.3.0");
      assert.deepStrictEqual(back.record.rollback, { from: "0.3.1" });
      const file = path.join(home, "state", "runtime.json");
      assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
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
