// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { keepsUtcClock } from "./settings.ts";

describe("keepsUtcClock", () => {
  it("is true for a zone on UTC's clock all year, whatever its name", () => {
    for (const zone of ["UTC", "Etc/UTC", "Etc/GMT", "Africa/Abidjan"]) {
      assert.isTrue(keepsUtcClock(zone, 2026), zone);
    }
  });

  it("is false for a zone off UTC, part of the year or all of it, and for an unknown one", () => {
    for (const zone of ["Europe/London", "Europe/Lisbon", "America/Sao_Paulo", "Asia/Kolkata"]) {
      assert.isFalse(keepsUtcClock(zone, 2026), zone);
    }
    assert.isFalse(keepsUtcClock("Mars/Olympus_Mons", 2026));
  });
});
