// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_TELEMETRY_HOST,
  DEFAULT_TELEMETRY_KEY,
  telemetryEnvironment,
  unreadableOptOut,
} from "./environment.ts";

const holdOf = (environment: Record<string, string>, development = false) =>
  telemetryEnvironment(environment, development).hold;

describe("the environment's say on usage data", () => {
  it("lets an installed server send to J3 Bots' project by default", () => {
    assert.deepStrictEqual(telemetryEnvironment({}, false), {
      hold: null,
      host: DEFAULT_TELEMETRY_HOST,
      key: DEFAULT_TELEMETRY_KEY,
    });
  });

  it("holds it under DO_NOT_TRACK, whatever else says yes", () => {
    assert.strictEqual(holdOf({ DO_NOT_TRACK: "1", J3_TELEMETRY_ENABLED: "true" }), "do-not-track");
    assert.strictEqual(holdOf({ DO_NOT_TRACK: "true" }), "do-not-track");
    assert.strictEqual(holdOf({ DO_NOT_TRACK: "0" }), null);
  });

  it("holds it when J3_TELEMETRY_ENABLED says no, or something it cannot read", () => {
    assert.strictEqual(holdOf({ J3_TELEMETRY_ENABLED: "false" }), "turned-off");
    assert.strictEqual(holdOf({ J3_TELEMETRY_ENABLED: "flase" }), "turned-off");
    assert.isTrue(unreadableOptOut({ J3_TELEMETRY_ENABLED: "flase" }));
    assert.isFalse(unreadableOptOut({ J3_TELEMETRY_ENABLED: "off" }));
  });

  it("holds it on a CI runner and in a checkout, unless J3_TELEMETRY_ENABLED says yes", () => {
    assert.strictEqual(holdOf({ CI: "true" }), "ci");
    assert.strictEqual(holdOf({ GITHUB_ACTIONS: "true" }), "ci");
    assert.strictEqual(holdOf({ CI: "false" }), null);
    assert.strictEqual(holdOf({}, true), "development");
    assert.strictEqual(holdOf({ CI: "1", J3_TELEMETRY_ENABLED: "true" }, true), null);
  });

  it("sends where J3_TELEMETRY_HOST and J3_TELEMETRY_KEY say, and holds it for a destination it cannot use", () => {
    assert.deepStrictEqual(
      telemetryEnvironment(
        { J3_TELEMETRY_HOST: "https://events.example.test/", J3_TELEMETRY_KEY: "phc_fork" },
        false,
      ),
      { hold: null, host: "https://events.example.test", key: "phc_fork" },
    );
    assert.strictEqual(holdOf({ J3_TELEMETRY_HOST: "events.example.test" }), "invalid-destination");
    assert.strictEqual(holdOf({ J3_TELEMETRY_KEY: " " }), "invalid-destination");
  });
});
