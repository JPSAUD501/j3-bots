// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { readCron } from "./schedule.ts";

describe("readCron", () => {
  it("reads a step only when it divides its cycle evenly", () => {
    expect(readCron("*/15 * * * *")).toEqual({ _tag: "everyMinutes", minutes: 15 });
    // `*/7` runs at :56 and again at :00: not every 7 minutes.
    expect(readCron("*/7 * * * *")).toBeNull();
    expect(readCron("0 */6 * * *")).toEqual({ _tag: "everyHours", hours: 6, minute: 0 });
    expect(readCron("0 */5 * * *")).toBeNull();
  });

  it("reads day 7 as Sunday", () => {
    const at = { hour: 9, minute: 30 };
    expect(readCron("30 9 * * 6,7")).toEqual({ _tag: "weekends", at });
    expect(readCron("30 9 * * 1,7")).toEqual({ _tag: "onDays", days: [0, 1], at });
  });

  it("refuses a monthly day 0, and a monthly day with weekdays", () => {
    expect(readCron("0 8 1 * *")).toEqual({ _tag: "monthly", day: 1, at: { hour: 8, minute: 0 } });
    expect(readCron("0 8 0 * *")).toBeNull();
    expect(readCron("0 8 1 * 1-5")).toBeNull();
  });
});
