// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { createI18n } from "../i18n/i18n";
import { at, context, plain } from "../test/fixtures";
import { activityTime, dividerTime, shortDuration, timeInSentence, upcomingTime } from "./time";

// 23:30 on Thursday, November 19 in São Paulo, already Friday in UTC.
const ctx = context("2026-11-20T02:30:00Z");

describe("activityTime", () => {
  it("counts days in the operator's time zone, not in UTC", () => {
    // Same calendar day in São Paulo, though the UTC dates differ.
    expect(plain(activityTime(at("2026-11-19T12:00:00Z"), ctx))).toBe("9:00 AM");
    expect(activityTime(at("2026-11-19T02:00:00Z"), ctx)).toBe("Yesterday");
  });

  it("names the weekday within a week and the date after", () => {
    expect(activityTime(at("2026-11-16T15:00:00Z"), ctx)).toBe("Monday");
    expect(activityTime(at("2026-10-02T15:00:00Z"), ctx)).toBe("Oct 2");
    expect(activityTime(at("2025-10-02T15:00:00Z"), ctx)).toBe("Oct 2, 2025");
  });
});

describe("upcomingTime and dividerTime", () => {
  it("say tomorrow and yesterday with the time", () => {
    expect(plain(upcomingTime(at("2026-11-20T11:47:00Z"), ctx))).toBe("Tomorrow at 8:47 AM");
    expect(plain(dividerTime(at("2026-11-18T20:00:00Z"), ctx))).toBe("Yesterday at 5:00 PM");
  });
});

describe("timeInSentence", () => {
  const words = (iso: string, c = ctx) => plain(timeInSentence(at(iso), c));

  it("reads in the middle of a sentence, past or future", () => {
    expect(words("2026-11-19T22:00:00Z")).toBe("at 7:00 PM");
    expect(words("2026-11-18T19:12:00Z")).toBe("yesterday at 4:12 PM");
    expect(words("2026-11-20T11:47:00Z")).toBe("tomorrow at 8:47 AM");
    expect(words("2026-11-16T15:00:00Z")).toBe("Monday at 12:00 PM");
    expect(words("2026-11-23T09:00:00Z")).toBe("Monday at 6:00 AM");
    expect(words("2026-10-02T15:00:00Z")).toBe("on Oct 2, 2026, 12:00 PM");
  });

  it("follows the language's own word order", () => {
    const pt = context("2026-11-20T02:30:00Z", "pt-BR");
    expect(words("2026-11-18T19:12:00Z", pt)).toBe("ontem às 16:12");
    expect(words("2026-11-20T11:47:00Z", pt)).toBe("amanhã às 08:47");
  });
});

describe("shortDuration", () => {
  const en = createI18n("en");
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
