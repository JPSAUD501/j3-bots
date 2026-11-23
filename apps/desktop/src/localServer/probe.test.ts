// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Probe from "./probe.ts";

/** Whether process `pid` runs. */
const runs = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a probe of the system", () => {
  it.live.skipIf(process.platform === "win32")(
    "ends by its deadline when the command ignores SIGTERM, and leaves no process",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pidFile = path.join(yield* fs.makeTempDirectoryScoped(), "pid");
        const startedAt = yield* Clock.currentTimeMillis;
        const output = yield* Probe.outputOf(
          "sh",
          ["-c", `trap '' TERM; echo $$ > '${pidFile}'; while :; do sleep 0.1; done`],
          { deadline: Duration.millis(300) },
        );
        assert.deepStrictEqual(output, Option.none());
        assert.isBelow((yield* Clock.currentTimeMillis) - startedAt, 5_000);
        const pid = Number((yield* fs.readFileString(pidFile)).trim());
        assert.isFalse(runs(pid));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    10_000,
  );

  it.live.skipIf(process.platform === "win32")("returns what the command printed", () =>
    Effect.gen(function* () {
      const output = yield* Probe.outputOf("sh", ["-c", "printf 'Mon Nov 23 09:14:02 2026'"], {
        deadline: Duration.seconds(5),
      });
      assert.deepStrictEqual(output, Option.some("Mon Nov 23 09:14:02 2026"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
