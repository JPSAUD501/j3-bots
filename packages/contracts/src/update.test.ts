// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ReceivedUpdateRefused, ReceivedUpdateStatus, UpdateStatus } from "./update.ts";

const status = (fields: Record<string, unknown> = {}) => ({
  api: 1,
  current: { version: "0.3.2-nightly.20261124.3", channel: "nightly" },
  channel: "stable",
  available: null,
  waitingForStable: true,
  refused: null,
  lastCheck: {
    at: "2026-11-24T09:00:00.000Z",
    failure: null,
    nextAt: "2026-11-24T15:07:00.000Z",
  },
  canUpdate: { _tag: "able" },
  state: { _tag: "idle" },
  run: null,
  lastResult: {
    outcome: "rolled-back",
    from: "0.3.1",
    to: "0.3.2-nightly.20261124.3",
    at: "2026-11-24T08:00:00.000Z",
    by: null,
    reason: "health-check",
    detail: "The new version did not become ready in 5 minutes.",
  },
  ...fields,
});

const received = Schema.decodeUnknownResult(Schema.toCodecJson(ReceivedUpdateStatus));
const written = Schema.decodeUnknownResult(Schema.toCodecJson(UpdateStatus));

describe("the update status a client receives", () => {
  it("reads what a server of this build writes", () => {
    const read = received(status());
    assert.isTrue(Result.isSuccess(read));
    if (Result.isSuccess(read)) {
      const state: ReceivedUpdateStatus["state"] = read.success.state;
      assert.deepStrictEqual(state, { _tag: "idle" });
      assert.strictEqual(read.success.lastResult?.reason, "health-check");
    }
  });

  it("reads a state, a reason, a channel or a refusal added later as unknown, where the server's own schema refuses them", () => {
    const later = status({
      channel: "beta",
      state: { _tag: "migrating", step: 2 },
      canUpdate: { _tag: "unable", reason: "on-battery", command: null },
    });
    const read = received(later);
    assert.isTrue(Result.isSuccess(read));
    if (Result.isSuccess(read)) {
      assert.strictEqual(read.success.channel, "unknown");
      assert.deepStrictEqual(read.success.state, { _tag: "unknown", kind: "migrating" });
      assert.deepStrictEqual(read.success.canUpdate, {
        _tag: "unable",
        reason: "unknown",
        command: null,
      });
    }
    assert.isTrue(Result.isFailure(written(later)));
    assert.deepStrictEqual(
      Schema.decodeSync(ReceivedUpdateRefused)({
        _tag: "UpdateRefused",
        reason: "on-fire",
        runningBots: null,
      }),
      { _tag: "UpdateRefused", reason: "unknown", runningBots: null },
    );
  });
});
