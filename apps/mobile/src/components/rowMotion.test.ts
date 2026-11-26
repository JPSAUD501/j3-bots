// SPDX-License-Identifier: AGPL-3.0-or-later
import { lift } from "@j3-bots/design-tokens";
import { describe, expect, it } from "vite-plus/test";
import { draw, settled, type ShownRows, taken, undrawn, unsettled } from "./rowMotion.ts";

/** Rows 64 px tall, one for each letter, or as tall as `heights` says. */
const rows = (
  keys: string,
  heights: Readonly<Record<string, number>> = {},
  query = "",
): ShownRows => ({
  rows: [...keys].map((key) => ({ key, height: heights[key] ?? 64 })),
  query,
});

/** The roster after it drew `keys` for the first time. */
const first = (keys: string, heights?: Readonly<Record<string, number>>) =>
  draw(undrawn, rows(keys, heights), false, 0);

describe("the mark a scrolled list keeps its place by", () => {
  it("moves down with the row first in view as a row rises above the view, waiting as that row does", () => {
    // Scrolled to C, which E passes on its way up: C steps one row down, after E sets off.
    const { motion, heading } = draw(first("ABCDEF"), rows("EABCDF"), false, 130);
    expect(motion.mark).toEqual({ top: 64, delay: lift.stepDelay });
    expect(heading).toBe(194);
  });

  it("moves up with the row first in view as a row above the view sinks below it", () => {
    expect(draw(first("ABCDEF"), rows("BCDEAF"), false, 130).motion.mark.top).toBe(-64);
  });

  it("follows the next row that stays when the row first in view is the one that lifts", () => {
    // Scrolled to A, which sinks: B, one row up, is the row kept.
    expect(draw(first("ABCDEF"), rows("BCDEAF"), false, 10).motion.mark.top).toBe(-64);
  });

  it("stays where it is at the top, where a row that rises comes into view", () => {
    const { motion, heading } = draw(first("ABCDEF"), rows("EABCDF"), false, 0);
    expect(motion.moves.get("E")).toBe("rise");
    expect(motion.mark).toEqual({ top: 0, delay: null });
    expect(heading).toBeNull();
  });

  it("moves as far as the kept row did in px, where rows differ in height", () => {
    // P is a band 100 tall that grows to 200 as B joins it.
    const before = first("PABC", { P: 100 });
    const after = rows("PAC", { P: 200 });
    // Scrolled to A, which the band pushed down as far as it grew, with no row lifting to wait for.
    expect(draw(before, after, false, 110).motion.mark).toEqual({ top: 100, delay: 0 });
    // Scrolled to B, which left: C moved down by the band and up by B.
    expect(draw(before, after, false, 170).motion.mark.top).toBe(36);
  });

  it("goes at once under reduced motion, where no row travels", () => {
    const drawn = draw(first("ABCDEF"), rows("EABCDF"), true, 130);
    expect(drawn.motion.moves.size).toBe(0);
    expect(drawn.motion.mark).toEqual({ top: 64, delay: null });
    // The list is still on its way there until it says where it is scrolled.
    expect(unsettled(drawn)).toBe(true);
    expect(settled(drawn).heading).toBeNull();
  });

  it("keeps, in a burst, the row first in view where the list is heading, and sets off with it at once", () => {
    const once = draw(first("ABCDEF"), rows("EABCDF"), false, 130);
    // The list says 140, part of the way: it is heading to 194, where C is first in view. D
    // passes C, already on its way, which steps down again.
    const twice = draw(once, rows("EABDCF"), false, 140);
    expect(twice.motion.mark).toEqual({ top: 128, delay: 0 });
    expect(twice.heading).toBe(258);
  });

  it("keeps the row first in view where the operator scrolled, once they take the list", () => {
    const once = draw(first("ABCDEF"), rows("EABCDF"), false, 130);
    // At 140 B is first in view, and D passing C does not move it.
    const twice = draw(taken(once), rows("EABDCF"), false, 140);
    expect(twice.motion.mark).toEqual({ top: 64, delay: null });
  });

  it("stays where it is once the rows settle, and when a search changes what is listed", () => {
    const arrived = settled(draw(first("ABCDEF"), rows("EABCDF"), false, 130));
    expect(arrived.motion.moves.size).toBe(0);
    expect(arrived.motion.mark).toEqual({ top: 64, delay: null });
    expect(unsettled(arrived)).toBe(false);
    const found = draw(arrived, rows("EA", {}, "a"), false, 194);
    expect(found.motion.moves.size).toBe(0);
    expect(found.motion.mark.top).toBe(64);
  });
});
