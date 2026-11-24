// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The avatar's model: which state a bot's avatar shows, the pose each state
 * holds, the small life each bot has on its own seeded clock, and how one
 * state turns into the next. Everything here is pure: a renderer keeps an
 * `AvatarSim`, steps it once a frame with `stepAvatar`, and draws
 * `avatarFace(sim)` through `avatarFrame` (`@j3-bots/design-tokens`). Under
 * reduced motion, off screen, or while a turn is stalled, it draws
 * `stillFace` instead: every state has a still form that says the same, and
 * a stalled turn's has no signal.
 *
 * The functions a frame runs are worklets, so the mobile app runs them on the
 * UI thread; elsewhere the directive is an ordinary string.
 */
import type { BotState, EntryPreview, Notification } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import {
  springs,
  type AvatarFace,
  type AvatarLight,
  type AvatarSignal,
} from "@j3-bots/design-tokens";

export const avatarStates = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "blocked",
  "unread",
  "speaking",
  "offline",
] as const;

/** What a bot's avatar shows. Every state reads in its still form alone. */
export type AvatarState = (typeof avatarStates)[number];

/** What the avatar shows besides the bot's own state. */
export interface AvatarContext {
  /** The bot said something the operator has not read. */
  readonly unread: boolean;
  /** A message of the bot's is arriving in front of the operator (`speakingUntil`). */
  readonly speaking: boolean;
  /** This client cannot see the bot's state: it is not connected to the server. */
  readonly offline: boolean;
}

export interface AvatarMood {
  readonly state: AvatarState;
  /**
   * The server reports the turn as possibly stuck: the avatar holds still,
   * without its signal, so stuck never looks busy.
   */
  readonly stalled: boolean;
}

/**
 * The avatar state for a bot. What concerns the operator comes first: a bot
 * that is blocked or waits on them shows it even while it speaks. A turn
 * under way shows it is under way; an idle bot with something unread shows
 * that. A client that has lost the server shows every bot asleep, since what
 * it last heard may no longer be true.
 */
export function avatarMood(state: BotState, context: AvatarContext): AvatarMood {
  if (context.offline) return { state: "offline", stalled: false };
  switch (state._tag) {
    case "blocked":
    case "waiting":
      return { state: state._tag, stalled: false };
    case "thinking":
    case "working":
      return { state: context.speaking ? "speaking" : state._tag, stalled: state.stalled };
    case "idle":
      if (context.speaking) return { state: "speaking", stalled: false };
      return { state: context.unread ? "unread" : "idle", stalled: false };
  }
}

/**
 * How a bot shows, still, in a notification about one of its entries: what
 * the notification means to the operator. A card waits on them, whatever
 * state the roster has heard so far. A blocked bot shows it is blocked, and
 * one waiting on another card shows that. Anything else is something the
 * operator has not read, so the bot shows it even while its turn goes on: a
 * reply's notification usually arrives before the roster hears the turn ended.
 */
export function notificationState(
  notification: Pick<Notification, "kind">,
  state: BotState,
): AvatarState {
  if (state._tag === "blocked" || state._tag === "waiting") return state._tag;
  switch (notification.kind) {
    case "question":
    case "approval":
    case "secret-request":
    case "browser-help":
      return "waiting";
    case "message":
    case "handoff":
      return "unread";
  }
}

/** How long a bot speaks after a message arrives, in ms: about as long as the conversation takes to bring its words in. */
const speakingTime = (length: number): number => Math.min(2800, Math.max(900, 600 + length * 18));

/**
 * Until when, in epoch ms, `botId` speaks after `lastEntry` arrives: a
 * message of its own, until its words are in. Null when its last entry is
 * not one.
 */
export function speakingUntil(lastEntry: EntryPreview | null, botId: string): number | null {
  if (lastEntry === null || lastEntry.kind !== "message") return null;
  if (lastEntry.author._tag !== "bot" || lastEntry.author.botId !== botId) return null;
  return DateTime.toEpochMillis(lastEntry.createdAt) + speakingTime(lastEntry.text.length);
}

/** A seed for a bot's variation, the same on every device and every run: a hash of its id. */
export function avatarSeed(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** What a state holds still, as the eased parts of its face reach it. */
interface Pose {
  readonly lidTop: number;
  readonly lidBottom: number;
  readonly pupil: number;
  readonly antennaAngle: number;
  readonly antennaLength: number;
  readonly tilt: number;
  readonly squash: number;
  readonly eyeLift: number;
  readonly cheek: number;
  readonly lightScale: number;
  /** A shut eye, bent by `curve` and tilted by `roll`, for the states that close it. */
  readonly shut: { readonly curve: number; readonly roll: number } | null;
  readonly light: AvatarLight;
  readonly signal: AvatarSignal | null;
}

const pose = (p: Partial<Pose>): Pose => ({
  lidTop: 0,
  lidBottom: 0,
  pupil: 6.2,
  antennaAngle: 8,
  antennaLength: 17,
  tilt: 0,
  squash: 0,
  eyeLift: 0,
  cheek: 0,
  lightScale: 1,
  shut: null,
  light: "body",
  signal: null,
  ...p,
});

/**
 * Each state's pose. The eye does the feeling: it narrows on the work, goes
 * wide when the bot needs the operator, smiles when there is news, and shuts
 * when the bot is stuck or asleep. The antenna's light is the status light.
 */
const POSES: Readonly<Record<AvatarState, Pose>> = {
  idle: pose({}),
  thinking: pose({ lidTop: 0.3, pupil: 5.4, antennaAngle: -16, tilt: -5, signal: "dots" }),
  working: pose({
    lidTop: 0.46,
    lidBottom: 0.32,
    pupil: 5.2,
    antennaAngle: 30,
    antennaLength: 16,
    tilt: 5,
    signal: "ring",
  }),
  waiting: pose({
    pupil: 8.6,
    antennaAngle: 0,
    antennaLength: 22,
    tilt: -7,
    light: "waiting",
    signal: "ping",
  }),
  blocked: pose({
    shut: { curve: 0, roll: 10 },
    antennaAngle: 78,
    antennaLength: 15,
    tilt: 3,
    squash: 0.07,
    light: "blocked",
  }),
  unread: pose({
    pupil: 7.2,
    cheek: 1,
    antennaAngle: -10,
    antennaLength: 18,
    light: "foreground",
    lightScale: 1.3,
  }),
  speaking: pose({ lidTop: 0.06, pupil: 6.4, antennaAngle: 6, eyeLift: -3, signal: "arcs" }),
  offline: pose({
    shut: { curve: -5, roll: 0 },
    antennaAngle: 84,
    antennaLength: 11,
    squash: 0.05,
  }),
};

/** A bot's own manner, from its seed: how it leans its antenna, how fast it breathes, where it rests its eye. */
export interface AvatarTraits {
  readonly lean: number;
  /** Seconds a breath takes. */
  readonly breath: number;
  readonly gazeX: number;
  readonly gazeY: number;
  /** Where its loops start, so no two bots move in step. */
  readonly phase: number;
}

/** No manner of its own: a still image's, and a preview's before it has a seed. */
export const plainTraits: AvatarTraits = { lean: 0, breath: 4, gazeX: 0, gazeY: 0, phase: 0 };

/** The next number of the seeded sequence and the state after it (mulberry32). */
function draw(state: number): readonly [number, number] {
  "worklet";
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

interface Spring {
  readonly x: number;
  readonly v: number;
}

const REST: Spring = { x: 0, v: 0 };

/**
 * A spring the body moves on, one of the interface's own (`springs` in the
 * tokens), with how far it travels from rest per unit of speed it is kicked
 * with before it turns back. Kicks are written as that distance, so they keep
 * their size whichever spring carries them.
 */
interface BodySpring {
  readonly frequency: number;
  readonly damping: number;
  readonly reach: number;
}

function bodySpring({ frequency, damping }: { frequency: number; damping: number }): BodySpring {
  const below = Math.sqrt(1 - damping * damping);
  const peak = Math.exp((-damping / below) * Math.atan2(below, damping));
  return { frequency, damping, reach: peak / (2 * Math.PI * frequency) };
}

/** The body's hop and the antenna's lag behind it overshoot on `pop`; its lean settles on `soft`. */
const HOP = bodySpring(springs.pop);
const LEAN = bodySpring(springs.soft);
const LAG = bodySpring(springs.pop);

/** `s` kicked so that, from rest, it would travel `reach` before turning back. */
function kick(s: Spring, reach: number, motion: BodySpring): Spring {
  "worklet";
  return { x: s.x, v: s.v + reach / motion.reach };
}

/** `s` stepped `dt` s toward `to` on `motion`. */
function spring(s: Spring, to: number, motion: BodySpring, dt: number): Spring {
  "worklet";
  const { frequency, damping } = motion;
  const w = 2 * Math.PI * frequency;
  const steps = Math.max(1, Math.ceil(dt / 0.006));
  const h = dt / steps;
  let x = s.x;
  let v = s.v;
  for (let i = 0; i < steps; i++) {
    v += (-w * w * (x - to) - 2 * damping * w * v) * h;
    x += v * h;
  }
  return { x, v };
}

/** The parts of the face that ease toward the pose. */
interface Eased {
  readonly lidTop: number;
  readonly lidBottom: number;
  readonly pupil: number;
  readonly gazeX: number;
  readonly gazeY: number;
  readonly shut: number;
  readonly curve: number;
  readonly roll: number;
  readonly mouth: number;
  readonly eyeLift: number;
  readonly squash: number;
  readonly antennaAngle: number;
  readonly antennaLength: number;
  readonly lightScale: number;
  readonly cheek: number;
}

/** One avatar's moving state. Plain data: a renderer keeps it and replaces it each frame. */
export interface AvatarSim {
  readonly state: AvatarState;
  /** Seconds on the avatar's own clock, which starts at a seeded time. */
  readonly time: number;
  readonly random: number;
  readonly traits: AvatarTraits;
  readonly eased: Eased;
  /** The body's hop and lean, and the antenna tip's lag, each a spring. */
  readonly hop: Spring;
  readonly tilt: Spring;
  readonly lagX: Spring;
  readonly lagY: Spring;
  /** Where the eye rests between glances. */
  readonly restX: number;
  readonly restY: number;
  readonly blinkAt: number;
  readonly nextBlink: number;
  readonly nextGlance: number;
  readonly nextAct: number;
}

/** Where the eye looks, the body bobs and the mouth opens in `state` at time `t`; `t` null for the still form. */
function motionAt(
  state: AvatarState,
  traits: AvatarTraits,
  t: number | null,
  rest: { readonly x: number; readonly y: number },
) {
  "worklet";
  const ph = traits.phase;
  const at = t ?? 0.9;
  switch (state) {
    case "thinking":
      return {
        x: 0.42 * Math.cos(at * 1.5 + ph) + 0.25,
        y: -0.62 + 0.2 * Math.sin(at * 1.5 + ph),
        bob: 0,
        lean: 0,
        mouth: 0,
      };
    case "working":
      return t === null
        ? { x: 0.45, y: 0.3, bob: 0, lean: 0, mouth: 0 }
        : {
            x: 0.62 * Math.sin(t * 3.4 + ph),
            y: 0.3,
            bob: Math.sin(t * 9.5 + ph) * 0.9,
            lean: Math.sin(t * 3.4 + ph) * 1.6,
            mouth: 0,
          };
    case "waiting":
      return { x: 0, y: 0, bob: 0, lean: 0, mouth: 0 };
    case "unread":
      return { x: 0, y: -0.25, bob: 0, lean: 0, mouth: 0 };
    case "speaking": {
      const mouth =
        t === null ? 0.8 : 0.3 + 0.7 * Math.abs(Math.sin(t * 10.5 + ph) * Math.sin(t * 3.7));
      return { x: 0, y: 0.05, bob: -mouth * 1.1, lean: 0, mouth };
    }
    case "idle":
    case "blocked":
    case "offline":
      return { x: rest.x, y: rest.y, bob: 0, lean: 0, mouth: 0 };
  }
}

/** The antenna's lean in `state`: its pose, plus the bot's own lean while its eye is open or it smiles. */
function antennaAngle(state: AvatarState, traits: AvatarTraits): number {
  "worklet";
  const p = POSES[state];
  return p.antennaAngle + (p.shut !== null ? 0 : traits.lean);
}

/** The eased parts of the face once they have reached `state`'s pose. */
function settled(
  state: AvatarState,
  traits: AvatarTraits,
  gazeX: number,
  gazeY: number,
  mouth: number,
): Eased {
  "worklet";
  const p = POSES[state];
  return {
    lidTop: p.lidTop,
    lidBottom: p.lidBottom,
    pupil: p.pupil,
    gazeX,
    gazeY,
    shut: p.shut === null ? 0 : 1,
    curve: p.shut?.curve ?? 0,
    roll: p.shut?.roll ?? 0,
    mouth,
    eyeLift: p.eyeLift,
    squash: p.squash,
    antennaAngle: antennaAngle(state, traits),
    antennaLength: p.antennaLength,
    lightScale: p.lightScale,
    cheek: p.cheek,
  };
}

/** The face from its eased parts and the body's motion. */
function compose(
  state: AvatarState,
  eased: Eased,
  body: {
    readonly hop: number;
    readonly bob: number;
    readonly tilt: number;
    readonly breath: number;
  },
  lag: { readonly x: number; readonly y: number },
  blink: number,
  signals: Pick<AvatarFace, "ring" | "ping" | "pingOpacity" | "arcs" | "dots">,
): AvatarFace {
  "worklet";
  const p = POSES[state];
  return {
    lidTop: eased.lidTop,
    lidBottom: eased.lidBottom,
    blink,
    pupil: eased.pupil,
    gazeX: eased.gazeX,
    gazeY: eased.gazeY,
    shut: eased.shut,
    curve: eased.curve,
    roll: eased.roll,
    cheek: eased.cheek,
    eyeLift: eased.eyeLift,
    mouth: eased.mouth,
    antennaAngle: eased.antennaAngle,
    antennaLength: eased.antennaLength,
    lagX: lag.x,
    lagY: lag.y,
    lightScale: eased.lightScale,
    light: p.light,
    hop: body.hop,
    bob: body.bob,
    tilt: body.tilt,
    breath: body.breath,
    squash: eased.squash,
    signal: p.signal,
    ...signals,
    asleep: state === "offline",
  };
}

/**
 * `state`'s still form: its pose held, the eye where the state looks, no
 * blink or breath, and its signal as one frame of it. What reduced motion
 * and a still image show. A `stalled` turn shows it without the signal, which
 * says the turn is under way: the eye and the antenna still say thinking or
 * working, and nothing says it is getting on.
 */
export function stillFace(
  state: AvatarState,
  traits: AvatarTraits = plainTraits,
  stalled = false,
): AvatarFace {
  "worklet";
  const m = motionAt(state, traits, null, { x: traits.gazeX, y: traits.gazeY });
  const face = compose(
    state,
    settled(state, traits, m.x, m.y, m.mouth),
    { hop: 0, bob: 0, tilt: POSES[state].tilt, breath: 0 },
    { x: 0, y: 0 },
    0,
    { ring: 135, ping: 0.45, pingOpacity: 0.6, arcs: [1, 1], dots: [1, 1] },
  );
  return stalled ? { ...face, signal: null } : face;
}

/** A new avatar in `state`, already in its pose, with `seed`'s manner and clock. */
export function createAvatar(seed: number, state: AvatarState): AvatarSim {
  let random = seed >>> 0 || 1;
  const next = () => {
    const [value, after] = draw(random);
    random = after;
    return value;
  };
  const traits: AvatarTraits = {
    lean: (next() - 0.5) * 14,
    breath: 3.2 + next() * 1.8,
    gazeX: (next() - 0.5) * 0.9,
    gazeY: -0.1 - next() * 0.35,
    phase: next() * 6.28,
  };
  const time = next() * 40;
  const m = motionAt(state, traits, time, { x: traits.gazeX, y: traits.gazeY });
  return {
    state,
    time,
    traits,
    eased: settled(state, traits, m.x, m.y, m.mouth),
    hop: REST,
    tilt: { x: POSES[state].tilt, v: 0 },
    lagX: REST,
    lagY: REST,
    restX: traits.gazeX,
    restY: traits.gazeY,
    blinkAt: -9,
    nextBlink: time + 1 + next() * 4,
    nextGlance: time + 2 + next() * 5,
    nextAct: time + 2 + next() * 4,
    random,
  };
}

/** Something that happens to an avatar, which it answers with a small move. */
export type AvatarPoke =
  /** A hop: it wants attention. */
  | "hop"
  /** The pointer comes over it. */
  | "hover"
  /** It is pressed. */
  | "press"
  /** It agrees: a message was sent to it. */
  | "nod"
  /** A key was typed in its name. */
  | "type"
  /** Its shape or color changed. */
  | "morph"
  /** It was just created. */
  | "arrive";

/** `sim` after `poke`. */
export function pokeAvatar(sim: AvatarSim, poke: AvatarPoke): AvatarSim {
  "worklet";
  let random = sim.random;
  const next = () => {
    const [value, after] = draw(random);
    random = after;
    return value;
  };
  const { hop, tilt, lagX, lagY } = sim;
  const T = sim.time;
  switch (poke) {
    case "hop":
    case "hover": {
      const reach = poke === "hop" ? 8.3 : 4.8;
      return {
        ...sim,
        hop: kick(hop, -reach, HOP),
        lagX: kick(lagX, (next() - 0.5) * 7.3, LAG),
        random,
      };
    }
    case "press":
      return { ...sim, hop: kick(hop, 5.9, HOP) };
    case "nod":
      return { ...sim, tilt: kick(tilt, 4.3, LEAN), hop: kick(hop, 2, HOP) };
    case "type":
      return {
        ...sim,
        hop: kick(hop, -2.2, HOP),
        lagX: kick(lagX, (next() - 0.5) * 4.1, LAG),
        random,
      };
    case "morph":
      return {
        ...sim,
        hop: kick({ x: 9, v: 0 }, -6.3, HOP),
        lagX: kick(lagX, 6.4, LAG),
        blinkAt: T + 0.12,
      };
    case "arrive":
      return {
        ...sim,
        hop: kick({ x: -150, v: 0 }, 10.3, HOP),
        lagX: kick(lagX, 9.2, LAG),
        lagY: { x: -14, v: lagY.v },
        blinkAt: T + 0.75,
        nextBlink: T + 1.15,
      };
  }
}

/**
 * `sim` turned to `state`. The pose eases over on the next frames; the turn
 * itself kicks the body once, in the state's own way: thinking tips its head,
 * working ducks to it, waiting and unread hop for attention, blocked slumps,
 * and a bot back to idle from anything but unread blinks.
 */
export function setAvatarState(sim: AvatarSim, state: AvatarState): AvatarSim {
  "worklet";
  if (state === sim.state) return sim;
  let random = sim.random;
  const next = () => {
    const [value, after] = draw(random);
    random = after;
    return value;
  };
  const T = sim.time;
  const turned: AvatarSim = {
    ...sim,
    state,
    nextAct: T + 1.2 + next() * 2,
    lagX: kick(sim.lagX, (next() - 0.5) * 5.5, LAG),
    lagY: kick(sim.lagY, -1.8, LAG),
    random,
  };
  switch (state) {
    case "thinking":
      return { ...turned, tilt: kick(turned.tilt, -2.4, LEAN) };
    case "working":
      return { ...turned, hop: kick(turned.hop, -2.8, HOP) };
    case "waiting":
    case "unread":
      return pokeAvatar(turned, "hop");
    case "blocked":
      return { ...turned, hop: kick(turned.hop, 3.6, HOP) };
    case "idle":
      return sim.state === "unread" ? turned : { ...turned, blinkAt: T };
    case "speaking":
    case "offline":
      return turned;
  }
}

/** Where the pointer is, relative to the avatar: each axis -1 to 1, or null when it is not near. */
export interface AvatarGaze {
  readonly x: number;
  readonly y: number;
}

/**
 * The gaze toward a pointer `dx`, `dy` px from the avatar's center: straight
 * at it, reaching the eye's edge from 220 px away.
 */
export function gazeToward(dx: number, dy: number): AvatarGaze {
  "worklet";
  const length = Math.hypot(dx, dy) || 1;
  const reach = Math.min(1, length / 220);
  return { x: (dx / length) * reach, y: (dy / length) * reach };
}

/** The pointer leads the eye only in states where the bot looks out at the operator. */
function followsPointer(state: AvatarState): boolean {
  "worklet";
  return state === "idle" || state === "waiting" || state === "speaking";
}

/**
 * `sim` after `dt` seconds: blinks, glances and idle fidgets on its seeded
 * timers, the state's loops, the pose eased toward, and the springs stepped.
 * `gaze`, when given, leads the eye in states that look at the operator.
 */
export function stepAvatar(sim: AvatarSim, dt: number, gaze: AvatarGaze | null): AvatarSim {
  "worklet";
  let random = sim.random;
  const next = () => {
    const [value, after] = draw(random);
    random = after;
    return value;
  };
  const T = sim.time + dt;
  const state = sim.state;
  const p = POSES[state];
  let { hop, tilt, lagX } = sim;
  let { blinkAt, nextBlink, nextGlance, nextAct, restX, restY } = sim;

  if (T > nextBlink) {
    blinkAt = T;
    nextBlink = T + (next() < 0.18 ? 0.3 : 2.2 + next() * 4.4);
  }
  if (T > nextGlance) {
    if (next() < 0.35) {
      restX = sim.traits.gazeX;
      restY = sim.traits.gazeY;
    } else {
      restX = (next() - 0.5) * 1.5;
      restY = (next() - 0.6) * 0.9;
    }
    nextGlance = T + 1.6 + next() * 5;
  }
  if (T > nextAct) {
    if (state === "waiting") {
      hop = kick(hop, -8.3, HOP);
      lagX = kick(lagX, (next() - 0.5) * 7.3, LAG);
      nextAct = T + 2.6 + next() * 2.2;
    } else if (state === "unread") {
      hop = kick(hop, -5.1, HOP);
      nextAct = T + 2 + next() * 1.8;
    } else if (state === "idle") {
      if (next() < 0.5) lagX = kick(lagX, (next() - 0.5) * 6.9, LAG);
      else tilt = kick(tilt, (next() - 0.5) * 2, LEAN);
      nextAct = T + 5 + next() * 9;
    } else nextAct = T + 4;
  }

  const m = motionAt(state, sim.traits, T, { x: restX, y: restY });
  const lookX = gaze !== null && followsPointer(state) ? gaze.x : m.x;
  const lookY = gaze !== null && followsPointer(state) ? gaze.y : m.y;
  const target = settled(state, sim.traits, lookX, lookY, m.mouth);
  const k = 1 - Math.exp(-dt * 13);
  const ks = 1 - Math.exp(-dt * 7);
  const kc = 1 - Math.exp(-dt * 16);
  const km = 1 - Math.exp(-dt * 26);
  const e = sim.eased;
  const toward = (from: number, to: number, rate: number) => from + (to - from) * rate;
  const closing = p.shut !== null;
  const eased: Eased = {
    lidTop: toward(e.lidTop, target.lidTop, k),
    lidBottom: toward(e.lidBottom, target.lidBottom, k),
    pupil: toward(e.pupil, target.pupil, k),
    gazeX: toward(e.gazeX, target.gazeX, ks),
    gazeY: toward(e.gazeY, target.gazeY, ks),
    shut: toward(e.shut, target.shut, kc),
    // A shut eye keeps the bend it last had while it opens again.
    curve: closing ? toward(e.curve, target.curve, k) : e.curve,
    roll: closing ? toward(e.roll, target.roll, k) : e.roll,
    mouth: toward(e.mouth, target.mouth, km),
    eyeLift: toward(e.eyeLift, target.eyeLift, k),
    squash: toward(e.squash, target.squash, ks),
    antennaAngle: toward(e.antennaAngle, target.antennaAngle, ks),
    antennaLength: toward(e.antennaLength, target.antennaLength, ks),
    lightScale: toward(e.lightScale, target.lightScale, k),
    cheek: toward(e.cheek, target.cheek, k),
  };

  return {
    ...sim,
    time: T,
    random,
    eased,
    hop: spring(hop, 0, HOP, dt),
    tilt: spring(tilt, p.tilt + m.lean, LEAN, dt),
    lagX: spring(lagX, 0, LAG, dt),
    lagY: spring(sim.lagY, 0, LAG, dt),
    restX,
    restY,
    blinkAt,
    nextBlink,
    nextGlance,
    nextAct,
  };
}

/** The face `sim` shows now. */
export function avatarFace(sim: AvatarSim): AvatarFace {
  "worklet";
  const T = sim.time;
  const ph = sim.traits.phase;
  const state = sim.state;
  const m = motionAt(state, sim.traits, T, { x: sim.restX, y: sim.restY });
  const resting = state === "offline" || state === "blocked";
  const wave = 0.5 + 0.5 * Math.sin(T * 7);
  const ping = (((T * 0.62 + ph) % 1) + 1) % 1;
  return compose(
    state,
    sim.eased,
    {
      hop: sim.hop.x,
      bob: m.bob,
      tilt: sim.tilt.x,
      breath: resting ? 0 : Math.sin((T * 2 * Math.PI) / sim.traits.breath) * 0.014,
    },
    { x: sim.lagX.x, y: sim.lagY.x },
    Math.min(1, Math.max(0, 1 - Math.abs((T - sim.blinkAt) / 0.085 - 1))),
    {
      ring: (T * 150) % 360,
      ping,
      pingOpacity: (1 - ping) * 0.9,
      arcs: [0.35 + 0.65 * wave, 0.35 + 0.65 * (1 - wave)],
      dots: [0.6 + 0.4 * Math.sin(T * 4.2), 0.6 + 0.4 * Math.sin(T * 4.2 - 1.3)],
    },
  );
}
