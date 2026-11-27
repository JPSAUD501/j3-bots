// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { DeviceId } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { UpdateRun } from "../update/run.ts";
import { failedRun, versionChange } from "./Reports.ts";

const AT = DateTime.makeUnsafe("2026-11-20T10:00:00Z");

const run = (outcome: UpdateRun["outcome"]): UpdateRun => ({
  schema: 1,
  id: "update_1",
  from: "0.13.0",
  to: "0.14.0",
  by: DeviceId.make("device_1"),
  stopWork: false,
  startedAt: AT,
  stage: { _tag: "restarting" },
  ...(outcome === undefined ? {} : { outcome }),
});

describe("how an update is told", () => {
  it("tells a new release once, however it was installed", () => {
    assert.deepStrictEqual(Option.getOrNull(versionChange("0.13.0", "0.14.0"))?.properties, {
      from: "0.13.0",
      to: "0.14.0",
      outcome: "updated",
      failure: null,
    });
    assert.isTrue(Option.isNone(versionChange("0.14.0", "0.14.0")));
    // The first start has nothing to compare with.
    assert.isTrue(Option.isNone(versionChange(null, "0.14.0")));
  });

  it("tells an update that did not end on the new release, with why, once", () => {
    const rolledBack = run({
      _tag: "rolled-back",
      at: AT,
      reason: "health-check",
      detail: "It did not start.",
    });
    assert.deepStrictEqual(Option.getOrNull(failedRun(rolledBack, null))?.properties, {
      from: "0.13.0",
      to: "0.14.0",
      outcome: "rolled-back",
      failure: "health-check",
    });
    assert.isTrue(Option.isNone(failedRun(rolledBack, "update_1")));
    // One that ended on the new release is told by the new release's start; one underway is not told yet.
    assert.isTrue(Option.isNone(failedRun(run({ _tag: "done", at: AT }), null)));
    assert.isTrue(Option.isNone(failedRun(run(undefined), null)));
  });
});
