// SPDX-License-Identifier: AGPL-3.0-or-later
import { LittleOneId, type LittleOne, type LittleOnes } from "@j3-bots/contracts";
import { litter } from "@j3-bots/design-tokens";
import { describe, expect, it } from "vite-plus/test";
import { at } from "../../test/fixtures.ts";
import {
  createLitter,
  type LitterPlace,
  litterPokes,
  type LitterSim,
  litterStrands,
  litterTravels,
  littleFace,
  littleSpot,
  settleLitter,
  shownLittleOnes,
  stepLitter,
  syncLitter,
} from "./littleOnes.ts";

const place: LitterPlace = { row: 28, size: 18, parent: 24, rise: 4 };
/** Where a little one's feet stand at the line `index`. */
const rest = (index: number) => index * place.row + place.row / 2 + place.size / 2;

const one = (id: string, status: LittleOne["status"] = "working"): LittleOne => ({
  id: LittleOneId.make(id),
  label: `Looking into ${id}`,
  status,
  startedAt: at("2026-11-20T10:00:00Z"),
  finishedAt: status === "working" ? null : at("2026-11-20T10:01:00Z"),
});
const family = (ones: ReadonlyArray<LittleOne>, working?: number): LittleOnes => ({
  ones,
  working: working ?? ones.filter((each) => each.status === "working").length,
  total: ones.length,
});

/** Steps `sim` for `seconds` at `rate` frames a second, and gathers what the bot is told to do. */
function run(sim: LitterSim, seconds: number, rate = 60) {
  let current = sim;
  const pokes: Array<string> = [];
  const frames: Array<LitterSim> = [];
  for (let i = 0; i < Math.round(seconds * rate); i++) {
    const next = stepLitter(current, 1 / rate, place);
    pokes.push(...litterPokes(current, next));
    frames.push(next);
    current = next;
  }
  return { sim: current, pokes, frames };
}

const empty = () => createLitter([], false, place);
const three = () => syncLitter(empty(), ["a", "b", "c"], [], false, place);
const spotOf = (sim: LitterSim, id: string) => {
  const found = sim.ones.find((each) => each.id === id);
  return found === undefined ? null : littleSpot(found);
};

describe("shownLittleOnes", () => {
  it("shows the ones that work, four at most, and counts the rest", () => {
    const shown = shownLittleOnes(
      family([one("a"), one("b", "done"), one("c"), one("d"), one("e"), one("f")], 7),
      true,
    );
    expect(shown.ones.map((each) => each.id)).toEqual(["a", "c", "d", "e"]);
    expect(shown.more).toBe(3);
  });

  it("names the ones that failed, so one of them leaves grey", () => {
    expect(shownLittleOnes(family([one("a"), one("b", "failed")]), true).failed).toEqual(["b"]);
  });

  it("shows none once the turn is over, whatever it left", () => {
    expect(shownLittleOnes(family([one("a")]), false)).toEqual({ ones: [], more: 0, failed: [] });
    expect(shownLittleOnes(null, true).ones).toEqual([]);
  });
});

describe("a split", () => {
  it("has the bot brace once, then spring up off each one as it comes out", () => {
    const split = three();
    expect([...litterPokes(empty(), split), ...run(split, 2).pokes]).toEqual([
      "brace",
      "pop",
      "pop",
      "pop",
    ]);
  });

  it("brings them out one after another, the first out bound furthest", () => {
    const { frames } = run(three(), litter.lead + litter.gap / 2);
    const out = (frames.at(-1)?.ones ?? []).filter((each) => littleSpot(each).shown);
    expect(out.map((each) => each.id)).toEqual(["c"]);
  });

  it("lands each at its own line, where it works", () => {
    const { sim } = run(three(), 2);
    expect(["a", "b", "c"].map((id) => spotOf(sim, id)?.y)).toEqual([rest(0), rest(1), rest(2)]);
    expect(sim.ones.every((each) => littleSpot(each).words)).toBe(true);
  });

  it("never has one pass another on its way down", () => {
    for (const frame of run(three(), 2, 240).frames) {
      const [a, b, c] = ["a", "b", "c"].map((id) => spotOf(frame, id));
      if (a?.shown && b?.shown) expect(a.y).toBeLessThanOrEqual(b.y);
      if (b?.shown && c?.shown) expect(b.y).toBeLessThanOrEqual(c.y);
    }
  });

  it("lands with weight: it squashes as it meets its line, then stands", () => {
    const { frames, sim } = run(three(), 2.5, 240);
    const squash = (frame: LitterSim) =>
      Math.max(...frame.ones.map((each) => littleFace(each, frame.time).squash));
    expect(Math.max(...frames.map(squash))).toBeGreaterThan(0.1);
    expect(Math.abs(squash(sim))).toBeLessThan(0.04);
  });

  it("is held to the bot by a strand as it comes out, which lets go", () => {
    const { frames } = run(three(), 2, 240);
    const drawn = frames.map((frame) => litterStrands(frame, place) !== "");
    expect(drawn.includes(true)).toBe(true);
    expect(drawn.at(-1)).toBe(false);
  });

  it("makes room: the block grows to its lines without a jump", () => {
    const { frames, sim } = run(three(), 2, 240);
    expect(sim.height.x).toBeCloseTo(3 * place.row + litter.foot, 1);
    const heights = [0, ...frames.map((frame) => frame.height.x)];
    for (let i = 1; i < heights.length; i++) {
      expect(Math.abs((heights[i] ?? 0) - (heights[i - 1] ?? 0))).toBeLessThan(3);
    }
  });

  it("does not brace again for one that joins while others are still coming out", () => {
    const first = run(three(), litter.lead / 2).sim;
    const joined = syncLitter(first, ["a", "b", "c", "d"], [], false, place);
    const { pokes, sim } = run(joined, 3);
    expect(pokes.filter((poke) => poke === "brace")).toEqual([]);
    expect(spotOf(sim, "d")?.y).toBe(rest(3));
  });
});

describe("the motion", () => {
  /** Where every little one is, to compare two runs. */
  const drawn = (sim: LitterSim) =>
    sim.ones.map((each) => [each.id, littleSpot(each).y] as const).sort();
  /** How squashed each one is drawn: eased toward what moves, so two rates agree closely, not exactly. */
  const squashed = (sim: LitterSim) =>
    sim.ones
      .toSorted((x, y) => x.id.localeCompare(y.id))
      .map((each) => littleFace(each, sim.time).squash);

  it("is the same at any frame rate", () => {
    const leaves = (rate: number) => {
      const landed = run(three(), 1.5, rate).sim;
      return run(syncLitter(landed, ["a", "c"], [], false, place), 0.3, rate).sim;
    };
    const [slow, fast] = [leaves(30), leaves(240)];
    expect(drawn(slow)).toEqual(drawn(fast));
    squashed(slow).forEach((squash, i) => expect(squash).toBeCloseTo(squashed(fast)[i] ?? 9, 1));
  });

  it("survives a frame of any length", () => {
    const whole = stepLitter(three(), 5, place);
    expect(drawn(whole)).toEqual([
      ["a", rest(0)],
      ["b", rest(1)],
      ["c", rest(2)],
    ]);
  });

  it("never jumps what is drawn, from the bot to the line and home again", () => {
    const landed = run(three(), 1.5, 240);
    const home = run(syncLitter(landed.sim, ["a", "c"], [], false, place), 1.5, 240);
    let before: number | null = null;
    for (const frame of [...landed.frames, ...home.frames]) {
      const spot = spotOf(frame, "b");
      if (spot === null || !spot.shown) continue;
      if (before !== null) expect(Math.abs(spot.y - before)).toBeLessThan(3);
      before = spot.y;
    }
  });
});

describe("one that ends", () => {
  const landed = () => run(three(), 1.5).sim;

  it("jumps back up into the bot, which reaches for it and gulps it", () => {
    const { sim, pokes } = run(syncLitter(landed(), ["a", "c"], [], false, place), 1.5);
    expect(pokes).toEqual(["reach", "gulp"]);
    expect(sim.ones.map((each) => each.id).sort()).toEqual(["a", "c"]);
  });

  it("keeps its line while it stands grey, so neither the next line nor what follows covers it", () => {
    const failed = syncLitter(landed(), ["a", "c"], ["b"], false, place);
    const { sim } = run(failed, litter.failed - 0.1);
    expect(spotOf(sim, "c")?.y).toBe(rest(2));
    expect(sim.height.x).toBeCloseTo(3 * place.row + litter.foot, 1);
  });

  it("gives up its line: the ones below close up, and its words go as it sets off", () => {
    const leaving = syncLitter(landed(), ["a", "c"], [], false, place);
    expect(spotOf(leaving, "b")?.words).toBe(false);
    const { sim } = run(leaving, 1.5);
    expect(spotOf(sim, "c")?.y).toBe(rest(1));
    expect(sim.height.x).toBeCloseTo(2 * place.row + litter.foot, 1);
  });

  it("stands grey a while when it failed, then goes home without a gulp", () => {
    const failed = syncLitter(landed(), ["a", "c"], ["b"], false, place);
    const waited = run(failed, litter.failed - 0.1);
    expect(spotOf(waited.sim, "b")).toMatchObject({ failed: true, words: true, y: rest(1) });
    expect(waited.pokes).toEqual([]);
    const { sim, pokes } = run(waited.sim, 1.5);
    expect(pokes).toEqual(["reach", "sulk"]);
    expect(spotOf(sim, "b")).toBeNull();
  });

  it("lands first when it ended on its way down", () => {
    const falling = run(three(), litter.lead + 0.05).sim;
    const { frames, pokes } = run(syncLitter(falling, ["a", "b"], [], false, place), 2.5, 240);
    expect(frames.some((frame) => spotOf(frame, "c")?.y === rest(2))).toBe(true);
    expect(pokes.at(-1)).toBe("gulp");
  });

  it("never comes out when it ended before its turn to", () => {
    const { sim, pokes } = run(syncLitter(three(), ["b", "c"], [], false, place), 2);
    expect(pokes.filter((poke) => poke === "pop")).toHaveLength(2);
    expect(sim.ones.map((each) => each.id).sort()).toEqual(["b", "c"]);
  });

  it("has its brothers look up after it", () => {
    const leaving = syncLitter(landed(), ["a", "c"], [], false, place);
    const watching = run(leaving, 0.4).sim;
    const a = watching.ones.find((each) => each.id === "a");
    expect(a === undefined ? 0 : littleFace(a, watching.time).gazeY).toBeLessThan(-0.5);
  });
});

describe("a family that is simply there", () => {
  it("stands at its lines when a conversation opens on it, and the bot does nothing", () => {
    const there = createLitter(["a", "b"], false, place);
    expect(there.ones.map((each) => littleSpot(each).y)).toEqual([rest(0), rest(1)]);
    expect(run(there, 1).pokes).toEqual([]);
    expect(litterTravels(there)).toBe(false);
  });

  it("settles at once without travel, and keeps one that failed while asked to", () => {
    const failed = syncLitter(run(three(), 1.5).sim, ["a", "d"], ["b"], false, place);
    const held = settleLitter(failed, place, true);
    expect(held.ones.map((each) => [each.id, littleSpot(each).failed]).sort()).toEqual([
      ["a", false],
      ["b", true],
      ["d", false],
    ]);
    // The one that failed keeps its line while it stands there: the new one takes the next.
    expect(spotOf(held, "d")?.y).toBe(rest(2));
    expect(litterPokes(failed, held)).toEqual([]);
    const released = settleLitter(held, place, false);
    expect(released.ones.map((each) => each.id).sort()).toEqual(["a", "d"]);
    expect(spotOf(released, "d")?.y).toBe(rest(1));
    expect(released.height.x).toBe(2 * place.row + litter.foot);
  });
});
