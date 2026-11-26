// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The avatar's model: which state a bot's avatar shows, the pose each state
 * holds, the life each bot has on its own seeded clock, how it answers the
 * pointer and a press, and how one state turns into the next. Everything here
 * is pure: a renderer keeps an `AvatarSim`, steps it once a frame with
 * `stepAvatar`, and draws `avatarFace(sim)` through `avatarFrame`
 * (`@j3-bots/design-tokens`). Under reduced motion, off screen, or while a
 * turn is stalled, it draws `stillFace` instead: every state has a still form
 * that says the same, and a stalled turn's has no signal.
 *
 * This is the one place an avatar moves from. Every part has one channel here
 * (the body's height, its squash, its lean, the antenna's lag, the eye's gaze,
 * its pupil and lids, the light), and nothing else writes them:
 *
 * - On the ground the body rides `pop`; in the air it falls as a thrown thing
 *   does (`AIR`). The lean rides `soft`, the antenna's tip and the light `pop`,
 *   the gaze `slide`. Each is the spring's own solution (`springStep`), so a
 *   frame of any length draws the same motion.
 * - What an avatar does, a hop, a happy squint, a glance around, is an *act*:
 *   a few beats, each a set of targets the channels travel toward. A new act
 *   takes the place of the one under way, and the channels carry on from where
 *   they are, at the speed they have. So nothing an avatar does resets it, and
 *   doing the same thing ten times in a second adds up to no more than once.
 *
 * The functions a frame runs are worklets, so the mobile app runs them on the
 * UI thread; elsewhere the directive is an ordinary string.
 */
import type { BotState, EntryPreview, Notification } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import {
  avatarViewBox,
  springs,
  springStep,
  stage,
  type AvatarFace,
  type AvatarLight,
  type AvatarSignal,
  type SpringState,
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
    case "connector":
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
  /** Which of the idle acts it is fondest of, 0 to 1. */
  readonly habit: number;
}

/** No manner of its own: a still image's, and a preview's before it has a seed. */
export const plainTraits: AvatarTraits = {
  lean: 0,
  breath: 4,
  gazeX: 0,
  gazeY: 0,
  phase: 0,
  habit: 0,
};

/** The next number of the seeded sequence and the state after it (mulberry32). */
export function draw(state: number): readonly [number, number] {
  "worklet";
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

const REST: SpringState = { x: 0, v: 0 };

/**
 * The air. Off the ground the body falls at `gravity`, in the avatar's
 * 100-unit box per second squared, so a bot of any size hangs as long: a hop
 * of 9 units lasts a quarter of a second, and the drop of an entrance half a
 * second. It leaves the ground only when the spring throws it up faster than
 * `takeoff`; anything gentler stays a wobble on the ground. However often it
 * is thrown, it never rises past `ceiling`.
 */
const AIR = { gravity: 1100, takeoff: 20, ceiling: 22 } as const;

/** How far an entrance drops, in the avatar's units: `stage.drop` times its own height, and `stage.rowDrop` in a list. */
const DROP = stage.drop * avatarViewBox.size;
const ROW_DROP = stage.rowDrop * avatarViewBox.size;

/** The speed, upward, that carries the body `height` units off the ground. */
function launchSpeed(height: number): number {
  "worklet";
  return Math.sqrt(2 * AIR.gravity * height);
}

/** The body's height: where it is, how fast, and whether it is in the air. */
interface Body {
  readonly x: number;
  readonly v: number;
  readonly air: boolean;
  /** Whether it came down onto the ground during the step. */
  readonly landed: boolean;
}

/**
 * The body after `seconds`, held toward `to` on the ground (0, or how deep a
 * press or a duck holds it down). Its flight and its landing are solved, not
 * stepped: the moment it meets the ground or leaves it falls inside the step,
 * wherever the frame ends.
 */
function moveBody(from: SpringState, inAir: boolean, to: number, seconds: number): Body {
  "worklet";
  const { frequency, damping } = springs.pop;
  const turn = 2 * Math.PI * frequency * Math.sqrt(1 - damping * damping);
  const decay = damping * 2 * Math.PI * frequency;
  let x = from.x;
  let v = from.v;
  let air = inAir;
  let landed = false;
  let left = seconds;
  // A landing and a rebound may share a step; a handful of passes covers any step.
  for (let pass = 0; pass < 6 && left > 1e-6; pass++) {
    if (air) {
      const fall = (-v + Math.sqrt(Math.max(0, v * v - 2 * AIR.gravity * x))) / AIR.gravity;
      if (fall > left) {
        x += v * left + (AIR.gravity * left * left) / 2;
        v += AIR.gravity * left;
        left = 0;
      } else {
        v += AIR.gravity * fall;
        x = 0;
        air = false;
        landed = true;
        left -= fall;
      }
      continue;
    }
    if (to <= 0) {
      // On the ground with nothing holding it down: when does the spring bring it back up to 0?
      const swing = (v + decay * x) / turn;
      let angle = Math.atan2(-x, swing);
      if (angle <= 1e-9) angle += Math.PI;
      const rise = angle / turn;
      if (rise < left) {
        const at = springStep({ x, v }, 0, frequency, damping, rise);
        if (at.v < -AIR.takeoff) {
          x = 0;
          v = at.v;
          air = true;
          left -= rise;
          continue;
        }
      }
    }
    const next = springStep({ x, v }, Math.max(0, to), frequency, damping, left);
    x = next.x;
    v = next.v;
    left = 0;
  }
  return { x, v, air, landed };
}

/**
 * The body thrown up to rise `height`. It leaves the ground at once, its
 * squash easing out behind it. Its speed is set, never added to, and less the
 * higher it already is, so being thrown again in the air is one more small
 * bounce and never a climb.
 */
function launch(body: SpringState, air: boolean, height: number): SpringState {
  "worklet";
  const room = air ? Math.min(1, Math.max(0, 1 + body.x / AIR.ceiling)) : 1;
  return { x: Math.min(0, body.x), v: Math.min(body.v, -launchSpeed(height) * room) };
}

/**
 * One beat of an act: until when it lasts, in seconds from the act's start,
 * and what it asks of the channels meanwhile. What a beat leaves out stays
 * the state's own.
 */
interface Beat {
  readonly until: number;
  /** Leaves the ground as the beat begins, to rise this high. */
  readonly launch?: number;
  /** Held this deep into the ground, which squashes it. */
  readonly duck?: number;
  /** A lean, in degrees. */
  readonly lean?: number;
  /** Stretched taller by this share of its height. */
  readonly tall?: number;
  /** The eye smiling, 0 to 1. */
  readonly smile?: number;
  /** The upper lid, in place of the state's. */
  readonly lid?: number;
  /** The pupil wider by this much. */
  readonly wide?: number;
  /** The antenna longer by this much. */
  readonly perk?: number;
  /** The antenna's tip thrown this far aside. */
  readonly flick?: number;
  /** Where the eye looks, in place of the state's look and of the pointer. */
  readonly look?: readonly [number, number];
  /** The whole body larger by this share. */
  readonly swell?: number;
}

/**
 * Everything an avatar does besides holding its state's pose. A press, a
 * change in the app or its own idle clock starts one; the next one replaces it.
 */
const ACTS = {
  // What a tap gets back, one of three.
  hop: [
    { until: 0.07, duck: 4.5, wide: 0.6 },
    { until: 0.75, launch: 9, smile: 1, lid: 0 },
  ],
  giggle: [
    { until: 0.1, lean: 6, smile: 1, lid: 0, duck: 2 },
    { until: 0.22, lean: -6, smile: 1, lid: 0 },
    { until: 0.34, lean: 4.5, smile: 1, lid: 0, duck: 1.5 },
    { until: 0.46, lean: -3, smile: 1, lid: 0 },
    { until: 0.95, smile: 1, lid: 0 },
  ],
  boing: [
    { until: 0.09, duck: 6.5 },
    { until: 0.22, launch: 5, tall: 0.05, wide: 1 },
    { until: 0.8, smile: 1, lid: 0, flick: 5 },
  ],
  // The pointer comes over it: it notices.
  perk: [{ until: 0.5, tall: 0.05, wide: 1.4, perk: 3.5, lid: 0 }],
  // What the app asks for.
  call: [
    { until: 0.07, duck: 3.5 },
    { until: 0.5, launch: 8, wide: 1 },
  ],
  wave: [
    { until: 0.06, duck: 2.5 },
    { until: 0.45, launch: 5, smile: 1 },
  ],
  nod: [
    { until: 0.13, duck: 3.2, lean: 2.5, lid: 0.35 },
    { until: 0.3, lid: 0 },
  ],
  type: [
    { until: 0.07, duck: 1.8, look: [0, 0.85] },
    { until: 1.1, look: [0, 0.85] },
  ],
  morph: [
    { until: 0.1, duck: 7, lid: 0.9 },
    { until: 0.6, launch: 6, wide: 1.2, lid: 0 },
  ],
  cheer: [
    { until: 0.08, duck: 5 },
    { until: 0.26, launch: 13, smile: 1, lid: 0, tall: 0.04 },
    { until: 1.1, smile: 1, lid: 0 },
  ],
  // An entrance: it looks down as it falls, then up and around, pleased to be here.
  fall: [{ until: 4, look: [0, 0.9], wide: 1.6, lid: 0 }],
  greet: [
    { until: 0.45, look: [0, -0.35], wide: 1.2, lid: 0 },
    { until: 1.3, smile: 1, lid: 0 },
  ],
  // A change of state, each in its own way.
  tip: [{ until: 0.28, lean: -3.5 }],
  duck: [{ until: 0.16, duck: 3.2 }],
  slump: [{ until: 0.4, duck: 4.5 }],
  // Its little ones (`littleOnes.ts`): it braces and wobbles before they come out, springs up off
  // each one, stretches up to meet one that comes home, and takes it in.
  brace: [
    { until: 0.17, duck: 12, look: [0, 0.95], lid: 0.42 },
    { until: 0.255, duck: 8, lean: 12, look: [0, 0.95], lid: 0.42 },
    { until: 0.34, duck: 12, lean: -11, look: [0, 0.95], lid: 0.42 },
    { until: 0.42, duck: 9, lean: 7, look: [0, 0.95], lid: 0.42 },
    { until: 0.9, duck: 11, look: [0, 0.95], lid: 0.42 },
  ],
  pop: [
    { until: 0.16, launch: 2.6, look: [0, 0.95], wide: 0.8, flick: 5, lid: 0.2 },
    { until: 0.36, duck: 9, look: [0, 0.95], lid: 0.42 },
  ],
  reach: [{ until: 0.8, tall: 0.07, look: [0, 0.95], lid: 0, wide: 0.5, perk: 2 }],
  gulp: [
    { until: 0.07, tall: 0.09, lid: 0.6 },
    { until: 0.2, duck: 8, lid: 0.6, swell: 0.1 },
    { until: 0.8, smile: 1, lid: 0, look: [0.3, -0.2] },
  ],
  sulk: [
    { until: 0.12, duck: 4.5, lid: 0.6, swell: 0.04 },
    { until: 0.65, lid: 0.55, look: [0.2, 0.75] },
  ],
  // Idle life.
  around: [
    { until: 0.55, look: [-0.85, -0.05] },
    { until: 1.2, look: [0.85, -0.1] },
    { until: 1.5, look: [0, -0.1] },
  ],
  stretch: [
    { until: 0.75, tall: 0.07, lid: 0.55, perk: 3 },
    { until: 0.95, duck: 2 },
  ],
  flick: [
    { until: 0.1, flick: 6 },
    { until: 0.22, flick: -5 },
  ],
  tilt: [{ until: 1.3, lean: 5.5, look: [0.5, -0.3] }],
  bounce: [
    { until: 0.06, duck: 2.5 },
    { until: 0.4, launch: 3.5 },
  ],
} as const satisfies Record<string, ReadonlyArray<Beat>>;

type ActName = keyof typeof ACTS;

/** What a tap may get back, and what an idle bot may do by itself. */
const TAP_ACTS = ["hop", "giggle", "boing"] as const satisfies ReadonlyArray<ActName>;
const IDLE_ACTS = [
  "around",
  "stretch",
  "flick",
  "tilt",
  "bounce",
] as const satisfies ReadonlyArray<ActName>;

/** The beat of `act` at `seconds` from its start, and where it is among them; null once it is over. */
function beatAt(
  act: ActName,
  seconds: number,
): { readonly beat: Beat; readonly index: number } | null {
  "worklet";
  const beats: ReadonlyArray<Beat> = ACTS[act];
  for (let index = 0; index < beats.length; index++) {
    const beat = beats[index];
    if (beat !== undefined && seconds < beat.until) return { beat, index };
  }
  return null;
}

/** The parts of the face that ease toward their target. */
interface Eased {
  readonly lidTop: number;
  readonly lidBottom: number;
  readonly pupil: number;
  readonly shut: number;
  readonly curve: number;
  readonly roll: number;
  readonly mouth: number;
  readonly eyeLift: number;
  readonly squash: number;
  /** The squash of a landing or a press, and the stretch of a rise or a fall: negative stretches. */
  readonly deform: number;
  readonly antennaAngle: number;
  readonly antennaLength: number;
  readonly lightScale: number;
  readonly cheek: number;
  /** How much the pointer has the eye, 0 to 1. */
  readonly attention: number;
}

/** One avatar's moving state. Plain data: a renderer keeps it and replaces it each frame. */
export interface AvatarSim {
  readonly state: AvatarState;
  /** Seconds on the avatar's own clock, which starts at a seeded time. */
  readonly time: number;
  readonly random: number;
  readonly traits: AvatarTraits;
  readonly eased: Eased;
  /** The body's height: negative in the air, positive pressed into the ground. */
  readonly hop: SpringState;
  readonly air: boolean;
  /** Held down by a press. */
  readonly pressed: boolean;
  /** How much larger the whole body is drawn, as a share: it swells as it takes a little one in. */
  readonly swell: SpringState;
  /** The body's lean, and the antenna tip's lag behind the body. */
  readonly tilt: SpringState;
  readonly lagX: SpringState;
  readonly lagY: SpringState;
  /** Where the eye looks. */
  readonly gazeX: SpringState;
  readonly gazeY: SpringState;
  /** How lit the antenna's light is, 0 dark to 1, and when it last came on. */
  readonly lit: SpringState;
  readonly litAt: number;
  /** An entrance under way: the light stays dark until the body lands. */
  readonly entering: boolean;
  /** What it is doing, since when, and to which side. */
  readonly act: ActName | null;
  readonly actAt: number;
  readonly actSide: number;
  /** The tap reaction it last gave, so the next one differs. */
  readonly lastTap: number;
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

/** Whether `state` rests: a bot blocked or asleep neither shifts its weight nor answers. */
function rests(state: AvatarState): boolean {
  "worklet";
  return state === "offline" || state === "blocked";
}

/** The antenna's lean in `state`: its pose, plus the bot's own lean while its eye is open or it smiles. */
function antennaAngle(state: AvatarState, traits: AvatarTraits): number {
  "worklet";
  const p = POSES[state];
  return p.antennaAngle + (p.shut !== null ? 0 : traits.lean);
}

/** The eased parts of the face once they have reached `state`'s pose. */
function settled(state: AvatarState, traits: AvatarTraits, mouth: number): Eased {
  "worklet";
  const p = POSES[state];
  return {
    lidTop: p.lidTop,
    lidBottom: p.lidBottom,
    pupil: p.pupil,
    shut: p.shut === null ? 0 : 1,
    curve: p.shut?.curve ?? 0,
    roll: p.shut?.roll ?? 0,
    mouth,
    eyeLift: p.eyeLift,
    squash: p.squash,
    deform: 0,
    antennaAngle: antennaAngle(state, traits),
    antennaLength: p.antennaLength,
    lightScale: p.lightScale,
    cheek: p.cheek,
    attention: 0,
  };
}

/** The face from its eased parts, its gaze and the body's motion. */
function compose(
  state: AvatarState,
  eased: Eased,
  gaze: { readonly x: number; readonly y: number },
  body: {
    readonly hop: number;
    readonly bob: number;
    readonly tilt: number;
    readonly breath: number;
    readonly swell: number;
  },
  lag: { readonly x: number; readonly y: number },
  blink: number,
  light: { readonly scale: number; readonly glow: number },
  signals: Pick<AvatarFace, "ring" | "ping" | "pingOpacity" | "arcs" | "dots">,
): AvatarFace {
  "worklet";
  const p = POSES[state];
  return {
    lidTop: eased.lidTop,
    lidBottom: eased.lidBottom,
    blink,
    pupil: eased.pupil,
    gazeX: Math.min(1, Math.max(-1, gaze.x)),
    gazeY: Math.min(1, Math.max(-1, gaze.y)),
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
    lightScale: eased.lightScale * light.scale,
    light: p.light,
    glow: light.glow,
    hop: body.hop,
    bob: body.bob,
    tilt: body.tilt,
    breath: body.breath,
    squash: eased.squash + eased.deform,
    swell: body.swell,
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
    settled(state, traits, m.mouth),
    m,
    { hop: 0, bob: 0, tilt: POSES[state].tilt, breath: 0, swell: 0 },
    { x: 0, y: 0 },
    0,
    { scale: 1, glow: 0 },
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
    habit: next(),
  };
  const time = next() * 40;
  const m = motionAt(state, traits, time, { x: traits.gazeX, y: traits.gazeY });
  return {
    state,
    time,
    traits,
    eased: settled(state, traits, m.mouth),
    hop: REST,
    air: false,
    pressed: false,
    swell: REST,
    tilt: { x: POSES[state].tilt, v: 0 },
    lagX: REST,
    lagY: REST,
    gazeX: { x: m.x, v: 0 },
    gazeY: { x: m.y, v: 0 },
    lit: { x: 1, v: 0 },
    litAt: -9,
    entering: false,
    act: null,
    actAt: 0,
    actSide: 1,
    lastTap: -1,
    restX: traits.gazeX,
    restY: traits.gazeY,
    blinkAt: -9,
    nextBlink: time + 1 + next() * 4,
    nextGlance: time + 2 + next() * 5,
    nextAct: time + 2 + next() * 4,
    random,
  };
}

/** Something that happens to an avatar, which it answers. */
export type AvatarPoke =
  /** A hop: it wants attention. */
  | "hop"
  /** The pointer comes over it. */
  | "hover"
  /** It is pressed, and held down until it is let go. */
  | "press"
  /** It is let go without a tap, as when the press slid off it. */
  | "release"
  /** It is let go where it was pressed: it answers, each time a little differently. */
  | "tap"
  /** It agrees: a message was sent to it. */
  | "nod"
  /** A key was typed in its name. */
  | "type"
  /** Its shape or color changed. */
  | "morph"
  /** Good news: it was made, or what it waited for came. */
  | "cheer"
  /** It is about to split into its little ones: it squashes down and wobbles. */
  | "brace"
  /** One of its little ones comes out: it springs up off it. */
  | "pop"
  /** One of its little ones is on its way home: it stretches up to meet it. */
  | "reach"
  /** One comes home having done its part: it gulps, swells and its light glows. */
  | "gulp"
  /** One comes home having failed: it takes it in, and looks down. */
  | "sulk"
  /** It comes in from above, into its place: an entrance. */
  | "arrive"
  /** The same from just above, as into a row of a list. */
  | "drop";

/** `sim` starting `act` now, in place of whatever it was doing. An act that opens with a launch leaves the ground at once. */
function begin(sim: AvatarSim, act: ActName, side = 1): AvatarSim {
  "worklet";
  const first: Beat | undefined = ACTS[act][0];
  const started: AvatarSim = { ...sim, act, actAt: sim.time, actSide: side };
  return first?.launch === undefined
    ? started
    : { ...started, hop: launch(sim.hop, sim.air, first.launch), air: true };
}

/** `sim` after `poke`. */
export function pokeAvatar(sim: AvatarSim, poke: AvatarPoke): AvatarSim {
  "worklet";
  // Asleep or blocked, it does not play; an entrance is not interrupted before it lands.
  const enters = poke === "arrive" || poke === "drop";
  if (!enters && (rests(sim.state) || (sim.entering && sim.air))) {
    return poke === "release" || poke === "tap" ? { ...sim, pressed: false } : sim;
  }
  const [chance, random] = draw(sim.random);
  switch (poke) {
    case "hop":
      return begin(sim, "call");
    case "hover":
      // Only a bot at rest notices: one already answering goes on with it.
      return sim.act === null && !sim.pressed ? begin(sim, "perk") : sim;
    case "press":
      return { ...sim, pressed: true, act: null };
    case "release":
      return { ...sim, pressed: false };
    case "tap": {
      // A press that began elsewhere and ends here is no tap.
      if (!sim.pressed) return sim;
      // One of the three, never the one before.
      const step = 1 + Math.floor(chance * (TAP_ACTS.length - 1));
      const pick = (Math.max(0, sim.lastTap) + step) % TAP_ACTS.length;
      const act = TAP_ACTS[pick] ?? "hop";
      return begin({ ...sim, pressed: false, lastTap: pick, random }, act, chance < 0.5 ? -1 : 1);
    }
    case "nod":
      return begin(sim, "nod");
    case "type":
      return begin(sim, "type");
    case "morph":
      return { ...begin(sim, "morph"), blinkAt: sim.time };
    case "cheer":
      return begin(sim, "cheer");
    case "brace":
      return begin(sim, "brace");
    case "pop":
      // Its antenna whips to one side, then the other.
      return begin({ ...sim, random }, "pop", chance < 0.5 ? -1 : 1);
    case "reach":
      return begin(sim, "reach");
    case "gulp":
      // Its eye shuts as it swallows, and its light glows once.
      return { ...begin(sim, "gulp"), blinkAt: sim.time, litAt: sim.time + 0.05 };
    case "sulk":
      return { ...begin(sim, "sulk"), blinkAt: sim.time };
    case "arrive":
    case "drop":
      return {
        ...sim,
        hop: { x: poke === "drop" ? -ROW_DROP : -DROP, v: 0 },
        air: true,
        pressed: false,
        entering: true,
        lit: REST,
        lagX: REST,
        lagY: REST,
        act: "fall",
        actAt: sim.time,
        actSide: 1,
        blinkAt: -9,
        nextBlink: sim.time + 2.2,
        nextAct: sim.time + 6,
      };
  }
}

/**
 * `sim` turned to `state`. The pose eases over on the next frames; the turn
 * itself moves the body once, in the state's own way: thinking tips its head,
 * working ducks to it, waiting and unread hop for attention, blocked slumps,
 * and a bot back to idle from anything but unread blinks.
 */
export function setAvatarState(sim: AvatarSim, state: AvatarState): AvatarSim {
  "worklet";
  if (state === sim.state) return sim;
  const [chance, random] = draw(sim.random);
  const turned: AvatarSim = {
    ...sim,
    state,
    pressed: false,
    nextAct: sim.time + 1.2 + chance * 2,
    random,
  };
  // An entrance plays out whatever the state turns to meanwhile.
  if (sim.entering) return turned;
  switch (state) {
    case "thinking":
      return begin(turned, "tip");
    case "working":
      return begin(turned, "duck");
    case "waiting":
      return begin(turned, "call");
    case "unread":
      return begin(turned, "wave");
    case "blocked":
      return begin(turned, "slump");
    case "idle":
      return sim.state === "unread" ? turned : { ...turned, blinkAt: sim.time };
    case "speaking":
    case "offline":
      return { ...turned, act: null };
  }
}

/**
 * The pointer as one avatar sees it: which way it is, each axis -1 to 1; how
 * much it has the avatar's eye, 0 to 1; and how close it is, 0 to 1.
 */
export interface AvatarNear {
  readonly x: number;
  readonly y: number;
  readonly attention: number;
  readonly closeness: number;
}

/**
 * How close the pointer must be for an avatar to look at it, in the avatar's
 * own widths from its centre: all of its attention within `full`, none past
 * `none`, easing between the two; the eye turns fully toward a pointer `turn`
 * away or more, and looks straight out at one right over it; within `close`
 * its pupil widens. An avatar narrower than `least` px counts as that wide, so
 * the small ones in a list are not blind.
 */
export const avatarNearness = { full: 2, none: 3, turn: 0.8, close: 0.9, least: 36 } as const;

function smooth(t: number): number {
  "worklet";
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * The pointer `dx`, `dy` px from the centre of an avatar `size` px wide, as
 * the avatar sees it; null when it is too far for the avatar to notice.
 */
export function pointerNear(dx: number, dy: number, size: number): AvatarNear | null {
  "worklet";
  const { full, none, turn, close, least } = avatarNearness;
  const length = Math.hypot(dx, dy);
  const widths = length / Math.max(size, least);
  if (widths >= none) return null;
  const reach = Math.min(1, widths / turn) / (length || 1);
  return {
    x: dx * reach,
    y: dy * reach,
    attention: 1 - smooth((widths - full) / (none - full)),
    closeness: 1 - smooth(widths / close),
  };
}

/** The pointer leads the eye only in states where the bot looks out at the operator. */
function followsPointer(state: AvatarState): boolean {
  "worklet";
  return state === "idle" || state === "waiting" || state === "unread" || state === "speaking";
}

/** A blink, 0 open to 1 shut, `seconds` after it began: shut fast, open slower. */
function blinkAt(seconds: number): number {
  "worklet";
  if (seconds <= 0 || seconds >= 0.22) return 0;
  if (seconds < 0.07) return smooth(seconds / 0.07);
  if (seconds < 0.09) return 1;
  return 1 - smooth((seconds - 0.09) / 0.13);
}

/** The halo about the light, 0 to 1, `seconds` after it came on: up at once, away slowly. */
function glowAt(seconds: number): number {
  "worklet";
  if (seconds <= 0 || seconds >= 0.9) return 0;
  if (seconds < 0.09) return seconds / 0.09;
  const fade = 1 - (seconds - 0.09) / 0.81;
  return fade * fade;
}

/**
 * `sim` after `dt` seconds: blinks, glances and idle acts on its seeded
 * timers, the act under way, the pose eased toward, and every spring moved.
 * `near`, when given, is the pointer close by (`pointerNear`): it leads the
 * eye in states that look at the operator, and the body leans a little its way.
 */
export function stepAvatar(sim: AvatarSim, dt: number, near: AvatarNear | null): AvatarSim {
  "worklet";
  let random = sim.random;
  const next = () => {
    const [value, after] = draw(random);
    random = after;
    return value;
  };
  const start = sim.time;
  const T = start + dt;
  const state = sim.state;
  const p = POSES[state];
  const resting = rests(state);
  let { act, actAt, actSide, entering, litAt } = sim;
  let { blinkAt: blinkedAt, nextBlink, nextGlance, nextAct, restX, restY } = sim;

  if (T > nextBlink) {
    blinkedAt = T;
    // One blink in five is two.
    nextBlink = T + (next() < 0.2 ? 0.27 : 2.2 + next() * 4.4);
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

  // The body, beat by beat: a beat that ends inside the step ends there, not at the frame.
  let hop = sim.hop;
  let air = sim.air;
  let tilt = sim.tilt;
  let landed = false;
  let beat: Beat | null = null;
  let at = start;
  const m = motionAt(state, sim.traits, T, { x: restX, y: restY });
  const attending = near !== null && followsPointer(state) ? near : null;
  const shift = resting
    ? 0
    : 1.1 * Math.sin(T * 0.37 + sim.traits.phase) +
      0.6 * Math.sin(T * 0.83 + sim.traits.phase * 1.7);
  const leanTo = p.tilt + m.lean + shift + (attending?.x ?? 0) * 3.5 * sim.eased.attention;
  for (let pass = 0; pass < 8 && at < T - 1e-6; pass++) {
    const now = act === null ? null : beatAt(act, at - actAt);
    if (now === null) act = null;
    beat = now?.beat ?? null;
    const until = beat === null ? T : Math.min(T, actAt + beat.until);
    const seconds = until - at;
    const held = sim.pressed ? 6 : (beat?.duck ?? 0);
    const moved = moveBody(hop, air, held, seconds);
    hop = { x: moved.x, v: moved.v };
    air = moved.air;
    landed = landed || moved.landed;
    tilt = springStep(
      tilt,
      leanTo + (beat?.lean ?? 0) * actSide,
      springs.soft.frequency,
      springs.soft.damping,
      seconds,
    );
    at = until;
    // The next beat begins: it may throw the body up.
    const following = act === null || at >= T - 1e-6 ? null : beatAt(act, at - actAt + 1e-6);
    if (following !== null && following.beat !== beat && following.beat.launch !== undefined) {
      hop = launch(hop, air, following.beat.launch);
      air = true;
    }
  }
  if (act !== null && beatAt(act, T - actAt) === null) {
    act = null;
    beat = null;
  }

  // An entrance ends as the body lands: the light comes on, and the bot looks up, pleased.
  if (entering && landed) {
    entering = false;
    litAt = T + 0.06;
    act = "greet";
    actAt = T;
    actSide = 1;
    beat = ACTS.greet[0];
    blinkedAt = T + 0.5;
  }

  // Idle life: now and then a bot does something by itself, each fond of its own.
  if (T > nextAct && act === null && !sim.pressed && !air && !entering) {
    if (state === "waiting") {
      act = "call";
      nextAct = T + 2.6 + next() * 2.2;
    } else if (state === "unread") {
      act = "wave";
      nextAct = T + 2 + next() * 1.8;
    } else if (state === "idle") {
      // Half the time its favorite, else any.
      const any = next() < 0.5 ? sim.traits.habit : next();
      act = IDLE_ACTS[Math.min(IDLE_ACTS.length - 1, Math.floor(any * IDLE_ACTS.length))] ?? null;
      nextAct = T + 5 + next() * 9;
    } else nextAct = T + 4;
    if (act !== null) {
      actAt = T;
      actSide = next() < 0.5 ? -1 : 1;
      const first: Beat | undefined = ACTS[act][0];
      beat = first ?? null;
      if (first?.launch !== undefined) {
        hop = launch(hop, air, first.launch);
        air = true;
      }
    }
  }

  // The eye: the act's look, else the pointer as far as it has the eye, else the state's own.
  const attention = sim.eased.attention;
  const look = beat?.look;
  const lookX =
    look !== undefined
      ? look[0] * actSide
      : attending === null
        ? m.x
        : m.x + (attending.x - m.x) * attention;
  const lookY =
    look !== undefined ? look[1] : attending === null ? m.y : m.y + (attending.y - m.y) * attention;
  const { frequency: glide, damping: glideDamping } = springs.slide;
  const gazeX = springStep(sim.gazeX, lookX, glide, glideDamping, dt);
  const gazeY = springStep(sim.gazeY, lookY, glide, glideDamping, dt);

  // The antenna's tip trails the body: behind a lean, below a rise, above a fall.
  const { frequency: pop, damping: popDamping } = springs.pop;
  const trailX = Math.min(7, Math.max(-7, -tilt.v * 0.06)) + (beat?.flick ?? 0) * actSide;
  const trailY = Math.min(8, Math.max(-9, -hop.v * 0.02));
  const lagX = springStep(sim.lagX, trailX, pop, popDamping, dt);
  const lagY = springStep(sim.lagY, trailY, pop, popDamping, dt);
  const lit = springStep(sim.lit, entering ? 0 : 1, pop, popDamping, dt);
  const swell = springStep(sim.swell, beat?.swell ?? 0, pop, popDamping, dt);

  const target = settled(state, sim.traits, m.mouth);
  const k = 1 - Math.exp(-dt * 13);
  const ks = 1 - Math.exp(-dt * 7);
  const kc = 1 - Math.exp(-dt * 16);
  const km = 1 - Math.exp(-dt * 26);
  const kd = 1 - Math.exp(-dt * 34);
  const e = sim.eased;
  const toward = (from: number, to: number, rate: number) => from + (to - from) * rate;
  const closing = p.shut !== null;
  const closeness = attending === null ? 0 : attending.closeness * attention;
  const eased: Eased = {
    lidTop: toward(e.lidTop, beat?.lid ?? target.lidTop, k),
    lidBottom: toward(e.lidBottom, target.lidBottom, k),
    pupil: toward(e.pupil, target.pupil + (beat?.wide ?? 0) + closeness * 1.3, k),
    shut: toward(e.shut, target.shut, kc),
    // A shut eye keeps the bend it last had while it opens again.
    curve: closing ? toward(e.curve, target.curve, k) : e.curve,
    roll: closing ? toward(e.roll, target.roll, k) : e.roll,
    mouth: toward(e.mouth, target.mouth, km),
    eyeLift: toward(e.eyeLift, target.eyeLift, k),
    squash: toward(e.squash, target.squash - (beat?.tall ?? 0), k),
    // In the air it stretches the way it travels; on the ground it squashes as deep as it is pressed.
    deform: toward(
      e.deform,
      air ? -Math.min(0.15, Math.abs(hop.v) * 0.00042) : Math.max(0, hop.x) * 0.018,
      kd,
    ),
    antennaAngle: toward(
      e.antennaAngle,
      target.antennaAngle + (attending?.x ?? 0) * 7 * attention,
      ks,
    ),
    antennaLength: toward(e.antennaLength, target.antennaLength + (beat?.perk ?? 0), k),
    lightScale: toward(e.lightScale, target.lightScale, k),
    cheek: toward(e.cheek, Math.max(target.cheek, beat?.smile ?? 0), k),
    attention: toward(e.attention, attending?.attention ?? 0, ks),
  };

  return {
    ...sim,
    time: T,
    random,
    eased,
    hop,
    air,
    swell,
    tilt,
    lagX,
    lagY,
    gazeX,
    gazeY,
    lit,
    litAt,
    entering,
    act,
    actAt,
    actSide,
    restX,
    restY,
    blinkAt: blinkedAt,
    nextBlink,
    nextGlance,
    nextAct,
  };
}

/**
 * Whether `sim` is in the middle of something: an entrance, an act, a press,
 * or a body still off the ground. A renderer that otherwise draws an avatar
 * still keeps stepping it until this ends.
 */
export function avatarBusy(sim: AvatarSim): boolean {
  "worklet";
  return (
    sim.entering ||
    sim.air ||
    sim.pressed ||
    sim.act !== null ||
    sim.time - sim.litAt < 1 ||
    Math.abs(sim.swell.x) > 0.002 ||
    Math.abs(sim.hop.x) > 0.05 ||
    Math.abs(sim.hop.v) > 2
  );
}

/** The face `sim` shows now. */
export function avatarFace(sim: AvatarSim): AvatarFace {
  "worklet";
  const T = sim.time;
  const ph = sim.traits.phase;
  const state = sim.state;
  const m = motionAt(state, sim.traits, T, { x: sim.restX, y: sim.restY });
  const wave = 0.5 + 0.5 * Math.sin(T * 7);
  const ping = (((T * 0.62 + ph) % 1) + 1) % 1;
  const breath = (T * 2 * Math.PI) / sim.traits.breath;
  // A smiling eye does not blink.
  const blink = sim.eased.cheek > 0.5 && POSES[state].cheek === 0 ? 0 : blinkAt(T - sim.blinkAt);
  return compose(
    state,
    sim.eased,
    { x: sim.gazeX.x, y: sim.gazeY.x },
    {
      hop: Math.min(0, sim.hop.x),
      bob: m.bob,
      tilt: sim.tilt.x,
      breath: rests(state) ? 0 : Math.sin(breath) * 0.014 + Math.sin(breath * 2 + ph) * 0.003,
      swell: sim.swell.x,
    },
    { x: sim.lagX.x, y: sim.lagY.x },
    blink,
    { scale: 0.5 + 0.5 * Math.max(0, sim.lit.x), glow: glowAt(T - sim.litAt) },
    {
      ring: (T * 150) % 360,
      ping,
      pingOpacity: (1 - ping) * 0.9,
      arcs: [0.35 + 0.65 * wave, 0.35 + 0.65 * (1 - wave)],
      dots: [0.6 + 0.4 * Math.sin(T * 4.2), 0.6 + 0.4 * Math.sin(T * 4.2 - 1.3)],
    },
  );
}
