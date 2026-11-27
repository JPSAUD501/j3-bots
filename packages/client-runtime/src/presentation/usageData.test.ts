// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Settings, TimeZone } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { usageDataSwitch } from "./usageData.ts";

const settings = (telemetry: Settings["telemetry"]): Settings => ({
  operatorName: null,
  timeZone: Schema.decodeSync(TimeZone)("UTC"),
  budgets: { hops: 4, fanOut: 2, concurrentTurns: 2 },
  notifications: { enabled: true, previews: true },
  updateChannel: "stable",
  autoUpdateHarnesses: true,
  suggestReplies: true,
  ...(telemetry === undefined ? {} : { telemetry }),
});

describe("usageDataSwitch", () => {
  it("is not offered by a server without usage data", () => {
    expect(usageDataSwitch(settings(undefined), { _tag: "idle" })).toBeNull();
  });

  it("shows what is being saved, then what the server holds", () => {
    const on = settings({ enabled: true, heldOff: false });
    expect(usageDataSwitch(on, { _tag: "saving", changes: { enabled: false } })?.checked).toBe(
      false,
    );
    expect(usageDataSwitch(on, { _tag: "saved", changes: { enabled: false } })?.checked).toBe(true);
  });

  it("shows off, whatever was saved, while the server's computer holds it off", () => {
    expect(usageDataSwitch(settings({ enabled: true, heldOff: true }), { _tag: "idle" })).toEqual({
      checked: false,
      heldOff: true,
      saving: false,
      failed: false,
    });
  });
});
