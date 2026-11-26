// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A bot's little ones: the small copies of itself it splits into while part
 * of its turn runs in parallel (decision 0071). This is their model, the one
 * place they move from, as `avatar.ts` is the bot's: a renderer keeps a
 * `LitterSim`, tells it who works now (`syncLitter`), steps it once a frame
 * (`stepLitter`), and draws each one's face (`littleFace`) through
 * `avatarFrame` where `littleSpot` says, with the strands that hold them to
 * the bot (`litterStrands`). What the bot itself does meanwhile, bracing,
 * springing up off each one, gulping one back, is its own avatar's: the
 * renderer passes on what `litterPokes` reports.
 *
 * A little one's life is a few stages, each solved, not stepped, so a frame of
 * any length draws the same motion and a stage that ends inside a frame ends
 * there:
 *
 * - it waits its turn while the bot braces (`queued`);
 * - it comes out from under the bot and falls to its line as a thrown thing
 *   does (`falling`), lands with a squash as deep as it came down fast, and
 *   works there, bobbing (`working`);
 * - one that failed stands grey a while (`failed`);
 * - one that ended ducks (`ducking`), jumps back up into the bot (`rising`),
 *   and is gone.
 *
 * Distances are px from the top of the family's own block, down; the bot's
 * feet stand `LitterPlace.rise` above it. Everything a frame runs is a
 * worklet, so the mobile app runs it on the UI thread.
 */
import type { LittleOne, LittleOnes } from "@j3-bots/contracts";
import {
  litter,
  springs,
  springStep,
  type AvatarFace,
  type SpringState,
} from "@j3-bots/design-tokens";
import { avatarSeed, draw, type AvatarPoke } from "./avatar.ts";

/** What a turn shows of its little ones: those that work now, and how many more do. */
export interface ShownLittleOnes {
  /** The first `litter.most` that work, in the order they started. */
  readonly ones: ReadonlyArray<LittleOne>;
  /** How many more work than are shown: "+2 more". */
  readonly more: number;
  /** Those of the turn known to have failed, by id: one of them leaves grey. */
  readonly failed: ReadonlyArray<string>;
}

const NONE: ShownLittleOnes = { ones: [], more: 0, failed: [] };

/**
 * The little ones a turn shows. Only one that works is drawn: one that ended
 * before this client saw it never appears, and one that ends while it is shown
 * goes home (`syncLitter`). `live` false, a turn that is over, shows none.
 */
export function shownLittleOnes(littleOnes: LittleOnes | null, live: boolean): ShownLittleOnes {
  if (littleOnes === null || !live) return NONE;
  const working = littleOnes.ones.filter((one) => one.status === "working");
  const ones = working.slice(0, litter.most);
  return {
    ones,
    more: Math.max(0, littleOnes.working - ones.length),
    failed: littleOnes.ones.filter((one) => one.status === "failed").map((one) => one.id),
  };
}

/** Where the family stands on a surface, in px: each measures its own rows. */
export interface LitterPlace {
  /** How tall one little one's line is. */
  readonly row: number;
  /** A little one's width and height. */
  readonly size: number;
  /** The bot's width and height. */
  readonly parent: number;
  /** How far above the top of the first line the bot's feet stand. */
  readonly rise: number;
}

type Stage = "queued" | "falling" | "working" | "failed" | "ducking" | "rising" | "gone";

/** The parts of a little one's face that ease toward their target. */
interface Eased {
  readonly lidTop: number;
  readonly lidBottom: number;
  readonly pupil: number;
  readonly cheek: number;
  readonly shut: number;
  readonly curve: number;
  readonly antennaAngle: number;
  readonly antennaLength: number;
  /** The stretch of a fall or a jump: negative stretches. */
  readonly deform: number;
}

/** One little one's moving state. Plain data. */
export interface LittleSim {
  readonly id: string;
  readonly stage: Stage;
  /** When its stage began, and for a stage that ends by the clock, when it ends: on the litter's clock. */
  readonly since: number;
  readonly due: number;
  /** How it ended, once this client knows it has; it goes home when it next can. */
  readonly end: "no" | "done" | "failed";
  /** Where its line is among the lines, from the first: it rides `slide` as lines above it leave. */
  readonly slot: SpringState;
  readonly slotTo: number;
  /** Its feet, and how fast they move, down positive. In the air, where and how fast it set off. */
  readonly y: number;
  readonly v: number;
  readonly y0: number;
  readonly v0: number;
  readonly squash: SpringState;
  readonly tilt: SpringState;
  /** How much of its size it has, from `litter.bud` inside the bot to 1. */
  readonly grow: SpringState;
  readonly gazeX: SpringState;
  readonly gazeY: SpringState;
  readonly eased: Eased;
  readonly random: number;
  /** Where its own beat starts, so no two bob in step, and which way it leans. */
  readonly phase: number;
  readonly lean: number;
  readonly side: number;
  readonly blinkAt: number;
  readonly nextBlink: number;
  /** It perks up until then: the pointer came over it. */
  readonly perkUntil: number;
  /** It looks up until then: a brother is on its way home. */
  readonly watchUntil: number;
}

/** A bot's family as it moves. Plain data: a renderer keeps it and replaces it each frame. */
export interface LitterSim {
  /** Seconds on the family's own clock. */
  readonly time: number;
  readonly ones: ReadonlyArray<LittleSim>;
  /** How tall the family's block is: it rides `slide`, so what follows it never jumps. */
  readonly height: SpringState;
  readonly heightTo: number;
  /** When the next one may come out: they follow one another `litter.gap` apart. */
  readonly nextPop: number;
  /** What has happened that the bot answers, counted (`litterPokes`). */
  readonly braces: number;
  readonly pops: number;
  readonly leaps: number;
  readonly gulps: number;
  readonly sulks: number;
}

const REST: SpringState = { x: 0, v: 0 };

/** Where a little one's feet stand when its line is `slot` px below the first. */
function restAt(slot: number, place: LitterPlace): number {
  "worklet";
  return slot + place.row / 2 + place.size / 2;
}

/** Where a little one's feet are as it comes out of the bot, and as it goes back in. */
function doorOf(place: LitterPlace): number {
  "worklet";
  return -place.rise - 1;
}
function homeOf(place: LitterPlace): number {
  "worklet";
  return -place.rise - place.size * 0.28;
}

/** What a little one's face and body go toward. */
interface Pose {
  readonly lidTop: number;
  readonly lidBottom: number;
  readonly pupil: number;
  readonly cheek: number;
  readonly shut: number;
  readonly curve: number;
  readonly antennaAngle: number;
  readonly antennaLength: number;
  readonly tilt: number;
  readonly lookX: number;
  readonly lookY: number;
  readonly squash: number;
}

const BORN: Pose = {
  lidTop: 0,
  lidBottom: 0,
  pupil: 9.6,
  cheek: 0,
  shut: 0,
  curve: 3,
  antennaAngle: 6,
  antennaLength: 8,
  tilt: 0,
  lookX: 0.3,
  lookY: 0.7,
  squash: 0,
};
/** At its line: its eye narrowed a little on what it does, looking at its words. */
const WORK: Pose = {
  ...BORN,
  lidTop: 0.26,
  lidBottom: 0.08,
  pupil: 7.4,
  antennaAngle: 14,
  tilt: 3,
  lookX: 0.6,
  lookY: 0.2,
};
/** Looking up at the bot: just landed, or watching a brother go home. */
const UP: Pose = { ...BORN, pupil: 9, lookX: 0, lookY: -0.95 };
/** The pointer came over it. */
const PERKED: Pose = { ...BORN, pupil: 9.4, lookX: 0.2, lookY: -0.3 };
/** Going home, having done its part. */
const HOME: Pose = { ...UP, pupil: 8.6, cheek: 1 };
/** It could not finish: its eye shut into a droop, its sprout fallen, slumped. */
const FAILED: Pose = {
  ...BORN,
  pupil: 7,
  shut: 1,
  curve: -5,
  antennaAngle: 82,
  antennaLength: 6,
  tilt: 4,
  lookX: 0,
  lookY: 0.4,
  squash: 0.1,
};

/** Whether `one` has its eye on its words at time `at`: at work, with nothing else to look at. */
function onItsWork(one: LittleSim, at: number): boolean {
  "worklet";
  // It looks up at the bot as it lands, and after a brother that leaves.
  return (
    one.stage === "working" &&
    at >= one.perkUntil &&
    at - one.since >= 0.5 &&
    at >= one.watchUntil
  );
}

/** What `one` goes toward at time `at`. */
function poseOf(one: LittleSim, at: number): Pose {
  "worklet";
  switch (one.stage) {
    case "queued":
    case "falling":
    case "gone":
      return BORN;
    case "working":
      if (onItsWork(one, at)) return WORK;
      return at < one.perkUntil ? PERKED : UP;
    case "failed":
      return FAILED;
    case "ducking":
      return one.end === "failed" ? { ...FAILED, squash: 0.18 } : { ...HOME, squash: 0.24 };
    case "rising":
      return one.end === "failed" ? { ...FAILED, squash: 0 } : HOME;
  }
}

function settledAt(pose: Pose): Eased {
  "worklet";
  return {
    lidTop: pose.lidTop,
    lidBottom: pose.lidBottom,
    pupil: pose.pupil,
    cheek: pose.cheek,
    shut: pose.shut,
    curve: pose.curve,
    antennaAngle: pose.antennaAngle,
    antennaLength: pose.antennaLength,
    deform: 0,
  };
}

/** A new little one for `id`, waiting to come out at `due`, bound for the line `slot` px down. */
function conceive(id: string, slot: number, due: number, place: LitterPlace): LittleSim {
  "worklet";
  let random = avatarSeed(id) || 1;
  const next = () => {
    const [value, after] = draw(random);
    random = after;
    return value;
  };
  const lean = (next() - 0.5) * 12;
  const phase = next() * 6.28;
  const side = next() < 0.5 ? -1 : 1;
  return {
    id,
    stage: "queued",
    since: 0,
    due,
    end: "no",
    slot: { x: slot, v: 0 },
    slotTo: slot,
    y: doorOf(place),
    v: 0,
    y0: doorOf(place),
    v0: 0,
    squash: REST,
    tilt: REST,
    grow: { x: litter.bud, v: 0 },
    gazeX: { x: BORN.lookX, v: 0 },
    gazeY: { x: BORN.lookY, v: 0 },
    // It comes out with its eye shut, and opens it on the way down.
    eased: { ...settledAt(BORN), shut: 1 },
    random,
    phase,
    lean,
    side,
    blinkAt: -9,
    nextBlink: due + 1.5 + next() * 3,
    perkUntil: -9,
    watchUntil: -9,
  };
}

/** `one` standing at its line and working, as when a conversation opens on a turn under way. */
function standing(one: LittleSim, at: number, place: LitterPlace): LittleSim {
  "worklet";
  return {
    ...one,
    stage: "working",
    // Long since: it does not look up as one that just landed does.
    since: at - 9,
    slot: { x: one.slotTo, v: 0 },
    y: restAt(one.slotTo, place),
    v: 0,
    squash: REST,
    tilt: { x: WORK.tilt, v: 0 },
    grow: { x: 1, v: 0 },
    gazeX: { x: WORK.lookX, v: 0 },
    gazeY: { x: WORK.lookY, v: 0 },
    eased: settledAt(WORK),
    nextBlink: at + 1 + (one.phase / 6.28) * 3,
  };
}

/** How tall the family's block is for `lines` lines: nothing for none. */
function heightOf(lines: number, place: LitterPlace): number {
  "worklet";
  return lines <= 0 ? 0 : lines * place.row + litter.foot;
}

/**
 * A family whose `working` little ones are simply there, at their lines: what
 * a conversation opened on a turn under way shows, and what reduced motion
 * shows. `lines` is how many lines the family takes, a "+N more" line counted.
 */
export function createLitter(
  working: ReadonlyArray<string>,
  lines: number,
  place: LitterPlace,
): LitterSim {
  "worklet";
  const ones: Array<LittleSim> = [];
  for (let i = 0; i < working.length; i++) {
    const id = working[i];
    if (id !== undefined) ones.push(standing(conceive(id, i * place.row, 0, place), 0, place));
  }
  const height = heightOf(lines, place);
  return {
    time: 0,
    ones,
    height: { x: height, v: 0 },
    heightTo: height,
    nextPop: 0,
    braces: 0,
    pops: 0,
    leaps: 0,
    gulps: 0,
    sulks: 0,
  };
}

/** Whether `one` is on its way out: it keeps the line it had, and takes none. */
function leaving(one: LittleSim): boolean {
  "worklet";
  return one.stage === "ducking" || one.stage === "rising" || one.stage === "gone";
}

/**
 * `sim` told who works now: `working`, the ids of the little ones shown, in
 * order, and `failed`, those of the turn known to have failed.
 *
 * - One that is new waits its turn to come out. The bot braces first, unless
 *   others are already on their way out; the new ones of one call come out
 *   last first, so the first out goes furthest down and none has to pass
 *   another.
 * - One that no longer works goes home: grey first if it failed. One still on
 *   its way down lands first; one that had not come out yet never does.
 * - The lines close up over one that left, and the block makes room.
 */
export function syncLitter(
  sim: LitterSim,
  working: ReadonlyArray<string>,
  failed: ReadonlyArray<string>,
  lines: number,
  place: LitterPlace,
): LitterSim {
  "worklet";
  const at = sim.time;
  const ones: Array<LittleSim> = [];
  let watch = false;
  for (const one of sim.ones) {
    const stays = working.indexOf(one.id) !== -1;
    if (stays || leaving(one) || one.end !== "no") {
      ones.push(one);
      continue;
    }
    // Never came out: it is simply not there.
    if (one.stage === "queued") continue;
    const end = failed.indexOf(one.id) !== -1 ? "failed" : "done";
    if (one.stage === "falling") {
      ones.push({ ...one, end });
      continue;
    }
    watch = watch || end === "done";
    ones.push(
      end === "failed"
        ? { ...one, end, stage: "failed", since: at, due: at + litter.failed }
        : { ...one, end, stage: "ducking", since: at, due: at + litter.duck },
    );
  }
  // The new ones, bound for their lines.
  const fresh: Array<number> = [];
  for (let i = 0; i < working.length; i++) {
    const id = working[i];
    if (id === undefined) continue;
    let known = false;
    for (const one of ones) if (one.id === id && !leaving(one) && one.end === "no") known = true;
    if (!known) fresh.push(i);
  }
  let nextPop = sim.nextPop;
  let braces = sim.braces;
  if (fresh.length > 0 && nextPop <= at) {
    nextPop = at + (fresh.length > 1 ? litter.lead : litter.leadOne);
    braces += 1;
  }
  for (let n = fresh.length - 1; n >= 0; n--) {
    const index = fresh[n];
    const id = index === undefined ? undefined : working[index];
    if (index === undefined || id === undefined) continue;
    ones.push(conceive(id, index * place.row, nextPop, place));
    nextPop += litter.gap;
  }
  // Each one that stays takes the line of its place among those that work.
  const placed = ones.map((one) => {
    const index = working.indexOf(one.id);
    const stays = index !== -1 && !leaving(one) && one.end === "no";
    const watching =
      watch && one.stage === "working" && one.end === "no"
        ? { ...one, watchUntil: at + litter.watch }
        : one;
    return stays ? { ...watching, slotTo: index * place.row } : watching;
  });
  return { ...sim, ones: placed, heightTo: heightOf(lines, place), nextPop, braces };
}

/** `sim` with the little one `id` perked up: the pointer came over it, or a finger. */
export function perkLittle(sim: LitterSim, id: string): LitterSim {
  "worklet";
  return {
    ...sim,
    ones: sim.ones.map((one) =>
      one.id === id && one.stage === "working"
        ? { ...one, perkUntil: sim.time + 0.7, squash: { x: one.squash.x, v: -2.2 } }
        : one,
    ),
  };
}

/** What happened to one little one within a step, for the bot to answer. */
interface Happened {
  pops: number;
  leaps: number;
  gulps: number;
  sulks: number;
}

/** When `one`'s stage ends, on the litter's clock; never, for one that works. */
function stageEnd(one: LittleSim, place: LitterPlace): number {
  "worklet";
  const g = litter.gravity;
  switch (one.stage) {
    case "queued":
    case "failed":
    case "ducking":
      return one.due;
    case "falling": {
      const drop = Math.max(0, restAt(one.slotTo, place) - one.y0);
      return one.since + (-one.v0 + Math.sqrt(one.v0 * one.v0 + 2 * g * drop)) / g;
    }
    case "rising":
      return one.due;
    case "working":
      // One that ended on its way down goes home as soon as it has landed and looked about.
      return one.end === "no" ? Number.POSITIVE_INFINITY : one.since + 0.35;
    case "gone":
      return Number.POSITIVE_INFINITY;
  }
}

/** `one` as its stage ends at `at`: the next stage begins. */
function advance(one: LittleSim, at: number, place: LitterPlace, did: Happened): LittleSim {
  "worklet";
  const g = litter.gravity;
  switch (one.stage) {
    case "queued":
      did.pops += 1;
      return {
        ...one,
        stage: "falling",
        since: at,
        y: doorOf(place),
        y0: doorOf(place),
        v: litter.thrown,
        v0: litter.thrown,
        grow: { x: litter.bud, v: 0 },
        // It tumbles a little as it comes out, each to its own side.
        tilt: { x: 0, v: one.side * 60 },
      };
    case "falling": {
      const landed = one.v0 + g * (at - one.since);
      return {
        ...one,
        stage: "working",
        since: at,
        slot: { x: one.slotTo, v: 0 },
        y: restAt(one.slotTo, place),
        v: 0,
        // It lands as deep as it came down fast, and rocks.
        squash: {
          x: one.squash.x,
          v: Math.max(one.squash.v, Math.min(9, (landed / place.size) * 0.55)),
        },
        tilt: { x: one.tilt.x, v: -one.side * 90 },
        blinkAt: at + 0.16,
      };
    }
    case "working":
      return one.end === "failed"
        ? { ...one, stage: "failed", since: at, due: at + litter.failed }
        : { ...one, stage: "ducking", since: at, due: at + litter.duck };
    case "failed":
      return { ...one, stage: "ducking", since: at, due: at + litter.failedDuck };
    case "ducking": {
      // Home: it jumps up into the bot, still rising as it arrives.
      const arrive = one.end === "failed" ? litter.arriveFailed : litter.arrive;
      const climb = Math.max(0, one.y - homeOf(place));
      const v0 = -Math.sqrt(arrive * arrive + 2 * g * climb);
      did.leaps += 1;
      return {
        ...one,
        stage: "rising",
        since: at,
        due: at + Math.max(0.04, (-v0 - arrive) / g),
        y0: one.y,
        v0,
        v: v0,
        squash: { x: one.squash.x, v: -3.4 },
      };
    }
    case "rising":
      if (one.end === "failed") did.sulks += 1;
      else did.gulps += 1;
      return { ...one, stage: "gone", since: at };
    case "gone":
      return one;
  }
}

/** `one` moved from `from` to `to` within its stage. */
function move(one: LittleSim, from: number, to: number, place: LitterPlace): LittleSim {
  "worklet";
  const dt = to - from;
  const g = litter.gravity;
  const pose = poseOf(one, to);
  const { frequency: pop, damping: popDamping } = springs.pop;
  const { frequency: glide, damping: glideDamping } = springs.slide;
  const slot = springStep(one.slot, one.slotTo, glide, glideDamping, dt);
  const inAir = one.stage === "falling" || one.stage === "rising";
  const since = to - one.since;
  const v = inAir ? one.v0 + g * since : 0;
  const y =
    one.stage === "queued"
      ? one.y
      : inAir
        ? one.y0 + one.v0 * since + (g * since * since) / 2
        : restAt(slot.x, place);
  // On its way home it shrinks into the bot over the last moments.
  const growTo =
    one.stage === "queued" ? litter.bud : one.stage === "rising" && to > one.due - litter.shrink
      ? litter.home
      : 1;
  // At work it bobs on its own beat; its squash breathes with the bob.
  const beat = one.stage === "working" ? Math.sin(to * 5.2 + one.phase + 1.2) * 0.028 : 0;
  const look = onItsWork(one, to) ? 0.28 * Math.sin(to * 2.3 + one.phase) : 0;
  const k = 1 - Math.exp(-dt * 13);
  const toward = (a: number, b: number, rate: number) => a + (b - a) * rate;
  const e = one.eased;
  const closing = pose.shut > 0;
  let random = one.random;
  let blinkAt = one.blinkAt;
  let nextBlink = one.nextBlink;
  if (to > nextBlink && one.stage === "working") {
    const [first, afterFirst] = draw(random);
    const [second, afterSecond] = draw(afterFirst);
    random = afterSecond;
    blinkAt = to;
    nextBlink = to + (first < 0.2 ? 0.27 : 2.2 + second * 4.4);
  }
  return {
    ...one,
    slot,
    y,
    v,
    squash: springStep(one.squash, pose.squash + beat, pop, popDamping, dt),
    tilt: springStep(one.tilt, pose.tilt, pop, popDamping, dt),
    grow: springStep(one.grow, growTo, pop, popDamping, dt),
    gazeX: springStep(one.gazeX, pose.lookX + look, glide, glideDamping, dt),
    gazeY: springStep(one.gazeY, pose.lookY, glide, glideDamping, dt),
    eased: {
      lidTop: toward(e.lidTop, pose.lidTop, k),
      lidBottom: toward(e.lidBottom, pose.lidBottom, k),
      pupil: toward(e.pupil, pose.pupil, k),
      cheek: toward(e.cheek, pose.cheek, k),
      shut: toward(e.shut, pose.shut, 1 - Math.exp(-dt * 16)),
      // A shut eye keeps the bend it last had while it opens again.
      curve: closing ? toward(e.curve, pose.curve, k) : e.curve,
      antennaAngle: toward(
        e.antennaAngle,
        pose.antennaAngle + (closing ? 0 : one.lean),
        1 - Math.exp(-dt * 7),
      ),
      antennaLength: toward(e.antennaLength, pose.antennaLength, k),
      deform: toward(
        e.deform,
        inAir ? -Math.min(0.16, (Math.abs(v) / place.size) * 0.012) : 0,
        1 - Math.exp(-dt * 34),
      ),
    },
    random,
    blinkAt,
    nextBlink,
  };
}

/** `sim` after `dt` seconds: every little one moved through whatever stages the time covers. */
export function stepLitter(sim: LitterSim, dt: number, place: LitterPlace): LitterSim {
  "worklet";
  const start = sim.time;
  const T = start + dt;
  const did: Happened = { pops: 0, leaps: 0, gulps: 0, sulks: 0 };
  const ones: Array<LittleSim> = [];
  for (const born of sim.ones) {
    let one = born;
    let at = start;
    // A stage may end, and the next begin, inside the step; a handful of passes covers any step.
    for (let pass = 0; pass < 8 && at < T - 1e-6 && one.stage !== "gone"; pass++) {
      const end = stageEnd(one, place);
      const until = Math.max(at, Math.min(T, end));
      one = move(one, at, until, place);
      at = until;
      if (end <= T) one = advance(one, end, place, did);
    }
    if (one.stage !== "gone") ones.push(one);
  }
  const { frequency, damping } = springs.slide;
  return {
    ...sim,
    time: T,
    ones,
    height: springStep(sim.height, sim.heightTo, frequency, damping, dt),
    pops: sim.pops + did.pops,
    leaps: sim.leaps + did.leaps,
    gulps: sim.gulps + did.gulps,
    sulks: sim.sulks + did.sulks,
  };
}

/**
 * `sim` with everything where it was going, at once, and nothing for the bot
 * to answer: what an off-screen family comes back to, and what reduced motion
 * shows. One that failed stays, grey, while `holdFailed`: reduced motion keeps
 * that it failed, and lets go of it a moment later with `holdFailed` false.
 */
export function settleLitter(sim: LitterSim, place: LitterPlace, holdFailed: boolean): LitterSim {
  "worklet";
  const ones: Array<LittleSim> = [];
  for (const one of sim.ones) {
    if (one.end === "no" && !leaving(one)) {
      ones.push(
        one.stage === "working"
          ? { ...one, slot: { x: one.slotTo, v: 0 }, y: restAt(one.slotTo, place) }
          : standing(one, sim.time, place),
      );
    } else if (holdFailed && one.end === "failed" && !leaving(one)) {
      ones.push({
        ...standing(one, sim.time, place),
        stage: "failed",
        since: sim.time,
        due: sim.time + litter.failed,
        eased: settledAt(FAILED),
        squash: { x: FAILED.squash, v: 0 },
        tilt: { x: FAILED.tilt, v: 0 },
      });
    }
  }
  return { ...sim, ones, height: { x: sim.heightTo, v: 0 }, nextPop: sim.time };
}

/**
 * What the bot does about what happened to its family between two steps, in
 * order: it braces before they come out, springs up off each one, stretches
 * up to meet one on its way home, and takes it in.
 */
export function litterPokes(before: LitterSim, after: LitterSim): ReadonlyArray<AvatarPoke> {
  "worklet";
  const pokes: Array<AvatarPoke> = [];
  if (after.braces > before.braces) pokes.push("brace");
  if (after.pops > before.pops) pokes.push("pop");
  if (after.leaps > before.leaps) pokes.push("reach");
  if (after.sulks > before.sulks) pokes.push("sulk");
  if (after.gulps > before.gulps) pokes.push("gulp");
  return pokes;
}

/**
 * Whether something of `sim` travels: one on its way out or home, a line
 * closing up, the block making room. A renderer draws every frame meanwhile;
 * little ones that only bob at their lines can do with fewer.
 */
export function litterTravels(sim: LitterSim): boolean {
  "worklet";
  if (Math.abs(sim.height.x - sim.heightTo) > 0.2 || Math.abs(sim.height.v) > 2) return true;
  for (const one of sim.ones) {
    if (one.stage !== "working" && one.stage !== "failed") return true;
    if (Math.abs(one.slot.x - one.slotTo) > 0.2 || Math.abs(one.squash.v) > 0.6) return true;
  }
  return false;
}

/** Where a renderer draws a little one. */
export interface LittleSpot {
  /** Its feet, px below the top of the family's block; its box is `LitterPlace.size` above them. */
  readonly y: number;
  /** Its line, px below the first: where its words are. */
  readonly line: number;
  /** How large it is drawn, about its feet. */
  readonly scale: number;
  /** Whether it shows at all: one that waits its turn inside the bot does not. */
  readonly shown: boolean;
  /** Whether it is in the air: drawn behind the ones that stand, which it passes on its way. */
  readonly travelling: boolean;
  /** Whether its words show: once it stands at its line, until it sets off home. */
  readonly words: boolean;
  /** Whether it failed: drawn grey. */
  readonly failed: boolean;
}

/** Lengths are rounded to a quarter of a px, so a little one at rest keeps the same numbers. */
function quarter(n: number): number {
  "worklet";
  return Math.round(n * 4) / 4;
}

export function littleSpot(one: LittleSim): LittleSpot {
  "worklet";
  return {
    y: quarter(one.y),
    line: quarter(one.slot.x),
    scale: Math.round(Math.max(0.02, one.grow.x) * 200) / 200,
    shown: one.stage !== "queued" && one.stage !== "gone",
    travelling: one.stage === "falling" || one.stage === "rising",
    words: one.stage === "working" || one.stage === "failed",
    failed: one.end === "failed" && one.stage !== "falling" && one.stage !== "working",
  };
}

function smooth(t: number): number {
  "worklet";
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** A blink, 0 open to 1 shut, `seconds` after it began. */
function blinkOf(seconds: number): number {
  "worklet";
  if (seconds <= 0 || seconds >= 0.22) return 0;
  if (seconds < 0.07) return smooth(seconds / 0.07);
  if (seconds < 0.09) return 1;
  return 1 - smooth((seconds - 0.09) / 0.13);
}

function faceOf(
  eased: Eased,
  gaze: { readonly x: number; readonly y: number },
  body: { readonly tilt: number; readonly squash: number; readonly bob: number },
  lag: { readonly x: number; readonly y: number },
  blink: number,
): AvatarFace {
  "worklet";
  return {
    lidTop: eased.lidTop,
    lidBottom: eased.lidBottom,
    blink,
    pupil: eased.pupil,
    gazeX: Math.min(1, Math.max(-1, gaze.x)),
    gazeY: Math.min(1, Math.max(-1, gaze.y)),
    shut: eased.shut,
    curve: eased.curve,
    roll: 0,
    cheek: eased.cheek,
    eyeLift: 0,
    mouth: 0,
    antennaAngle: eased.antennaAngle,
    antennaLength: eased.antennaLength,
    lagX: lag.x,
    lagY: lag.y,
    lightScale: 1,
    light: "body",
    glow: 0,
    hop: 0,
    bob: body.bob,
    tilt: body.tilt,
    breath: 0,
    squash: body.squash,
    swell: 0,
    signal: null,
    ring: 0,
    ping: 0,
    pingOpacity: 0,
    arcs: [0, 0],
    dots: [0, 0],
    asleep: false,
  };
}

/** The face `one` shows at the family's time `time`, for `avatarFrame` drawn as a little one. */
export function littleFace(one: LittleSim, time: number): AvatarFace {
  "worklet";
  const working = one.stage === "working";
  // A smiling eye does not blink.
  const blink = one.eased.cheek > 0.5 ? 0 : blinkOf(time - one.blinkAt);
  return faceOf(
    one.eased,
    { x: one.gazeX.x, y: one.gazeY.x },
    {
      tilt: one.tilt.x,
      squash: one.squash.x + one.eased.deform,
      bob: working ? Math.sin(time * 5.2 + one.phase) * 1.7 : 0,
    },
    // Its sprout trails its body: behind a rock, above a landing.
    {
      x: Math.min(6, Math.max(-6, -one.tilt.v * 0.05)),
      y: Math.min(6, Math.max(-7, -one.squash.v * 1.3)),
    },
    blink,
  );
}

/** A little one's still form: at work, or failed. What reduced motion draws. */
export function stillLittle(failed: boolean): AvatarFace {
  "worklet";
  const pose = failed ? FAILED : WORK;
  return faceOf(
    settledAt(pose),
    { x: pose.lookX, y: pose.lookY },
    { tilt: pose.tilt, squash: pose.squash, bob: 0 },
    { x: 0, y: 0 },
    0,
  );
}

const HALF = Math.PI / 2;

/**
 * A strand of one body stretched to another, as a filled path: the two
 * circles `c1`, `r1` and `c2`, `r2` joined by a neck that is `spread` thick, 0
 * a thread to 1 as wide as the bodies.
 */
function strand(
  x1: number,
  y1: number,
  r1: number,
  x2: number,
  y2: number,
  r2: number,
  spread: number,
): string {
  "worklet";
  const d = Math.hypot(x2 - x1, y2 - y1);
  if (r1 < 0.3 || r2 < 0.3 || spread <= 0.01 || d <= Math.abs(r1 - r2) + 0.4) return "";
  const clamp = (n: number) => Math.min(1, Math.max(-1, n));
  const overlapping = d < r1 + r2;
  const u1 = overlapping ? Math.acos(clamp((r1 * r1 + d * d - r2 * r2) / (2 * r1 * d))) : 0;
  const u2 = overlapping ? Math.acos(clamp((r2 * r2 + d * d - r1 * r1) / (2 * r2 * d))) : 0;
  const between = Math.atan2(y2 - y1, x2 - x1);
  const widest = Math.acos(clamp((r1 - r2) / d));
  const a1 = between + u1 + (widest - u1) * spread;
  const a2 = between - u1 - (widest - u1) * spread;
  const a3 = between + Math.PI - u2 - (Math.PI - u2 - widest) * spread;
  const a4 = between - Math.PI + u2 + (Math.PI - u2 - widest) * spread;
  const n = (value: number) => Math.round(value * 100) / 100;
  const at = (x: number, y: number, angle: number, r: number) =>
    `${n(x + Math.cos(angle) * r)} ${n(y + Math.sin(angle) * r)}`;
  const span = Math.hypot(
    x1 + Math.cos(a1) * r1 - (x2 + Math.cos(a3) * r2),
    y1 + Math.sin(a1) * r1 - (y2 + Math.sin(a3) * r2),
  );
  const handle = Math.min(spread * 2.4, span / (r1 + r2)) * Math.min(1, (d * 2) / (r1 + r2));
  const p = (x: number, y: number, angle: number, r: number, turn: number, reach: number) =>
    at(x + Math.cos(angle) * r, y + Math.sin(angle) * r, angle + turn, reach);
  return (
    `M${at(x1, y1, a1, r1)}C${p(x1, y1, a1, r1, -HALF, r1 * handle)} ${p(x2, y2, a3, r2, HALF, r2 * handle)} ${at(x2, y2, a3, r2)}` +
    `A${n(r2)} ${n(r2)} 0 ${d > r1 ? 0 : 1} 0 ${at(x2, y2, a4, r2)}` +
    `C${p(x2, y2, a4, r2, -HALF, r2 * handle)} ${p(x1, y1, a2, r1, HALF, r1 * handle)} ${at(x1, y1, a2, r1)}Z`
  );
}

/**
 * The strands that hold little ones to the bot, as one path filled in the
 * bot's color: from the bot to each one still close on its way out, and to
 * one about to go back in. In px, x from the middle of the family's column, y
 * from the top of its block. Empty when no strand shows.
 */
export function litterStrands(sim: LitterSim, place: LitterPlace): string {
  "worklet";
  let path = "";
  const botY = -place.rise - place.parent * 0.4;
  const botR = place.parent * 0.31 * 0.92;
  for (const one of sim.ones) {
    const reach =
      one.stage === "falling" ? litter.strand : one.stage === "rising" ? litter.reach : 0;
    if (reach === 0) continue;
    const size = place.size * one.grow.x;
    const y = one.y - size * 0.4;
    const away = Math.abs(y - botY);
    if (away >= reach) continue;
    path += strand(0, botY, botR, 0, y, size * 0.31 * 0.9, 0.22 + 0.4 * (1 - away / reach));
  }
  return path;
}
