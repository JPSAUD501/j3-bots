// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { at, context, plain } from "../../test/fixtures.ts";
import { fullTime } from "../presentation/time.ts";
import { activityTime, dividerTime, timeInSentence } from "./time.ts";

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

describe("dividerTime", () => {
  it("says yesterday with the time", () => {
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

describe("times never break inside themselves", () => {
  it("keeps the time whole inside longer phrases, which may still break elsewhere", () => {
    // A full no-break space: a narrow one is set too thin to read as a gap at small sizes.
    const wholeAtEnd = /8:47\u00A0AM$/;
    expect(fullTime(at("2026-11-23T11:47:00Z"), ctx)).toMatch(wholeAtEnd);
    expect(timeInSentence(at("2026-11-20T11:47:00Z"), ctx)).toMatch(wholeAtEnd);
    expect(dividerTime(at("2026-11-17T11:47:00Z"), ctx)).toMatch(wholeAtEnd);
  });
});
