// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { at } from "../../test/fixtures.ts";
import { clockTime, formatMoment, shortDuration } from "./time.ts";

describe("times never break inside themselves", () => {
  /** A space a line may end at. No-break spaces are not. */
  const breakable = /[^\S\u00A0\u202F]/;

  it("keeps every clock time in one piece, in every language and at every hour", () => {
    for (const locale of ["en", "pt-BR"] as const) {
      const c = {
        i18n: { locale },
        timeZone: "America/Sao_Paulo",
        now: at("2026-11-20T02:30:00Z"),
      };
      for (let hour = 0; hour < 24; hour++) {
        const moment = at(`2026-11-19T${String(hour).padStart(2, "0")}:47:00Z`);
        expect(clockTime(moment, c)).not.toMatch(breakable);
      }
    }
    // A period written with spaces of its own, as Spanish does.
    const es = new Intl.DateTimeFormat("es", {
      timeStyle: "short",
      hour12: true,
      timeZone: "UTC",
    });
    expect(formatMoment(es, Date.UTC(2026, 10, 19, 20, 47))).not.toMatch(breakable);
  });
});

describe("shortDuration", () => {
  const en = { locale: "en" };
  it("keeps the two largest units and drops empty ones", () => {
    expect(shortDuration(40_000, en)).toBe("40s");
    expect(shortDuration(125_000, en)).toBe("2m 5s");
    expect(shortDuration(3 * 3_600_000 + 30_000, en)).toBe("3h");
    expect(shortDuration(26 * 3_600_000 + 5 * 60_000, en)).toBe("1d 2h");
  });

  it("never goes below zero", () => {
    expect(shortDuration(0, en)).toBe("0s");
    expect(shortDuration(-5_000, en)).toBe("0s");
  });
});
