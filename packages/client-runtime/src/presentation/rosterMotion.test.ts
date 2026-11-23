// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vite-plus/test";
import { keptPlaces, moveDelay, rosterMotion, rosterMoves } from "./rosterMotion.ts";

const moves = (before: string, after: string) =>
  Object.fromEntries(rosterMoves([...before], [...after]));

describe("rosterMoves", () => {
  it("lifts the bot that rose to the top and steps the rows it passed, leaving the rest", () => {
    expect(moves("ABCDE", "DABCE")).toEqual({ D: "rise", A: "step", B: "step", C: "step" });
  });

  it("lifts a row that sank, and steps the rows it passed up", () => {
    expect(moves("ABCD", "BCAD")).toEqual({ A: "sink", B: "step", C: "step" });
  });

  it("moves the row that rose when two rows swap", () => {
    expect(moves("ABC", "BAC")).toEqual({ B: "rise", A: "step" });
  });

  it("draws a burst that landed together as one move from the order last drawn", () => {
    expect(moves("ABCDE", "EDABC")).toEqual({
      E: "rise",
      D: "rise",
      A: "step",
      B: "step",
      C: "step",
    });
  });

  it("steps the rows a new or removed row pushes along, and lifts none", () => {
    expect(moves("ABC", "XABC")).toEqual({ A: "step", B: "step", C: "step" });
    expect(moves("ABC", "AC")).toEqual({ C: "step" });
  });

  it("moves nothing when the order is the same", () => {
    expect(moves("ABC", "ABC")).toEqual({});
  });
});

describe("rosterMotion", () => {
  const view = (keys: string, query = "") => ({ keys: [...keys], query });

  it("moves nothing on the first rows drawn", () => {
    expect(rosterMotion(null, view("ABC")).size).toBe(0);
  });

  it("moves nothing when the operator's search changed what is listed", () => {
    expect(rosterMotion(view("ABC"), view("CA", "a")).size).toBe(0);
    expect(rosterMotion(view("CA", "a"), view("ABC")).size).toBe(0);
  });

  it("moves the rows when the roster reorders under the same search", () => {
    expect(Object.fromEntries(rosterMotion(view("AB", "a"), view("BA", "a")))).toEqual({
      B: "rise",
      A: "step",
    });
  });
});

describe("keptPlaces", () => {
  const kept = (before: string, after: string) =>
    keptPlaces([...before], [...after], rosterMoves([...before], [...after]));

  it("keeps the rows in view where they are as a row in view rises above it", () => {
    // From C on, the first row in view moved one place down: the list scrolls one place with it.
    // From E on, the first row in view is F, still in its place.
    expect(kept("ABCDEF", "EABCDF")).toEqual([1, 1, 1, 1, 0, 0]);
  });

  it("keeps the rows in view where they are as a row above the view sinks below it", () => {
    expect(kept("ABCDEF", "BCDEAF")).toEqual([-1, -1, -1, -1, -1, 0]);
  });

  it("never keeps the place of a row that lifts away, nor of one that left", () => {
    expect(keptPlaces([..."ABC"], [..."BC"], new Map())).toEqual([-1, -1, -1]);
    expect(kept("ABC", "CAB")).toEqual([1, 1, 0]);
  });
});

describe("moveDelay", () => {
  it("has the rows a lifted row passes follow it, and no row wait when none lifts", () => {
    const rising = rosterMoves([..."ABC"], [..."CAB"]);
    expect(moveDelay("rise", rising, 40)).toBe(0);
    expect(moveDelay("step", rising, 40)).toBe(40);
    const pushed = rosterMoves([..."AB"], [..."XAB"]);
    expect(moveDelay("step", pushed, 40)).toBe(0);
  });
});
