// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Settings, TimeZone } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { editsAfterFailedSave, noEdits, settingsPatch } from "./settings";

const zone = Schema.decodeSync(TimeZone);

const saved: Settings = {
  operatorName: null,
  timeZone: zone("America/Sao_Paulo"),
  budgets: { hops: 4, fanOut: 2, concurrentTurns: 2 },
  notifications: { previews: true },
};

describe("settingsPatch", () => {
  it("sends only the field the operator changed", () => {
    expect(settingsPatch(saved, { name: " Ana ", zone: null })).toEqual({
      _tag: "changes",
      changes: { operatorName: "Ana" },
    });
    // A time zone changed on another device is not written back.
    expect(
      settingsPatch({ ...saved, timeZone: zone("Europe/Lisbon") }, { name: "Ana", zone: null }),
    ).toEqual({ _tag: "changes", changes: { operatorName: "Ana" } });
  });

  it("sends nothing for an edit back to the saved value, and refuses a name too long", () => {
    expect(settingsPatch(saved, { name: "  ", zone: "America/Sao_Paulo" })).toEqual({
      _tag: "unchanged",
    });
    expect(settingsPatch(saved, { name: "n".repeat(201), zone: null })).toEqual({
      _tag: "invalid",
    });
  });
});

describe("editsAfterFailedSave", () => {
  it("gives a form that did not see the save the values it sent", () => {
    expect(editsAfterFailedSave(noEdits, { operatorName: "Ana" })).toEqual({
      name: "Ana",
      zone: null,
    });
    expect(editsAfterFailedSave(noEdits, { operatorName: null })).toEqual({
      name: "",
      zone: null,
    });
  });

  it("keeps what the form already holds", () => {
    expect(
      editsAfterFailedSave(
        { name: "Ana, typed", zone: null },
        { operatorName: "Ana", timeZone: zone("Europe/Lisbon") },
      ),
    ).toEqual({ name: "Ana, typed", zone: "Europe/Lisbon" });
  });
});
