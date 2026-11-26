// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How a bot's avatar is drawn: a body (`avatarShapes`) with one lens eye and
 * an antenna whose tip is the status light. This file turns an `AvatarFace`,
 * the handful of numbers that say how open the eye is, where it looks and how
 * the body leans, into the geometry every renderer draws: the web's SVG, the
 * mobile app's SVG on the UI thread, and PNG stills. Which face a state shows
 * and how it moves over time is the client runtime's (`avatarSim`).
 *
 * Coordinates are in the avatar's 100-unit box, of which `avatarViewBox` is
 * the part a renderer frames; the antenna's light and its signals may reach
 * past it. The eye's parts are in the eye's own frame, centered on it, which
 * `AvatarFrame.eye` places on the body.
 *
 * Nothing is clipped: the eyelids and the cheek are drawn over the lens in
 * the body's color, and a status light's cutout in the color of what the
 * avatar sits on, so a renderer only paints shapes in order, back to front:
 * stalk, body, lens, pupil, glint, cheek, lids, closed-eye arc, mouth, the
 * light's cutout, signal, light.
 */
import { avatarShapes } from "./avatarShapes.ts";
import {
  avatarCast,
  avatarShapeNames,
  type AvatarShapeName,
  botColors,
  type BotColor,
} from "./names.ts";
import type { ColorRole } from "./tokens.ts";

/**
 * The square a renderer frames: every body with its outline, which reaches
 * 96 at the feet, centered across; at rest the light stays inside its top.
 */
export const avatarViewBox = { x: 4.5, y: 5, size: 91 } as const;

/** The eye's radius. */
export const AVATAR_EYE = 14;

/** An avatar this size in px or smaller is small: its eye, stalk and light grow so they stay legible. */
export const AVATAR_SMALL = 28;

/** Where the status light takes its color from: the bot's own color or a color role. */
export type AvatarLight = "body" | Extract<ColorRole, "waiting" | "blocked" | "foreground">;

/** The signal around the light, one per state that has one. */
export type AvatarSignal = "ring" | "ping" | "arcs" | "dots";

/**
 * Everything that changes how an avatar looks, at one moment. Values the
 * client runtime eases between states are continuous; the rest come with
 * the state.
 */
export interface AvatarFace {
  /** How far the upper lid has come down, 0 open to 1 shut. */
  readonly lidTop: number;
  /** How far the lower lid has come up, 0 to 1. */
  readonly lidBottom: number;
  /** A blink in progress, 0 to 1: it shuts both lids at once. */
  readonly blink: number;
  /** The pupil's radius. */
  readonly pupil: number;
  /** Where the eye looks, each -1 to 1 of how far the pupil can travel. */
  readonly gazeX: number;
  readonly gazeY: number;
  /** The eye closed into an arc, 0 open to 1: asleep or slumped. */
  readonly shut: number;
  /** The closed eye's bend: positive smiles up, negative droops. */
  readonly curve: number;
  /** The closed eye's tilt, in degrees. */
  readonly roll: number;
  /** A cheek pushing up from under the eye, 0 to 1: the eye smiles. */
  readonly cheek: number;
  /** How far the eye sits above its place. */
  readonly eyeLift: number;
  /** How open the mouth is, 0 to 1. */
  readonly mouth: number;
  /** The antenna's lean from upright, in degrees, clockwise. */
  readonly antennaAngle: number;
  readonly antennaLength: number;
  /** How far the antenna's tip lags behind the body. */
  readonly lagX: number;
  readonly lagY: number;
  /** The light's size, 1 normal. */
  readonly lightScale: number;
  readonly light: AvatarLight;
  /** A halo about the light as it comes on, 0 none to 1. */
  readonly glow: number;
  /** The body's rise off the ground, 0 or negative: up is negative. */
  readonly hop: number;
  /** A small vertical bounce on top of `hop`. */
  readonly bob: number;
  /** The body's lean about its feet, in degrees. */
  readonly tilt: number;
  /** Breathing, a small share that stretches the body up. */
  readonly breath: number;
  /** A squash, as a share of the body's height; negative stretches it, as a fall does. */
  readonly squash: number;
  /** A swell: the whole body larger by this share, about its feet, as when it takes a little one back in. */
  readonly swell: number;
  readonly signal: AvatarSignal | null;
  /** The working ring's turn, in degrees. */
  readonly ring: number;
  /** The waiting ping's spread, 0 to 1, and how strongly it shows. */
  readonly ping: number;
  readonly pingOpacity: number;
  /** The speaking arcs' strength, inner and outer, 0 to 1. */
  readonly arcs: readonly [number, number];
  /** The thinking dots' size, near and far, 0 to 1. */
  readonly dots: readonly [number, number];
  /** Offline: drawn without color and half seen. */
  readonly asleep: boolean;
}

/** An affine transform as SVG's `matrix(a b c d e f)` takes it. */
export type AvatarMatrix = readonly [number, number, number, number, number, number];

export interface AvatarCircle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** What a renderer draws for one face. */
export interface AvatarFrame {
  /** Places the body and everything on it, the antenna included, in the box. */
  readonly body: AvatarMatrix;
  /** Places the eye's parts on the body. */
  readonly eye: AvatarMatrix;
  /** Whether the lens, pupil, glint, cheek and lids show; a shut eye shows only its arc. */
  readonly open: boolean;
  readonly pupil: AvatarCircle;
  /** None on small avatars, where it would be a speck. */
  readonly glint: AvatarCircle | null;
  /** Filled in the body's color. Empty paths draw nothing. */
  readonly cheek: string;
  readonly upperLid: string;
  readonly lowerLid: string;
  /** The shut eye, stroked in the lens color, `arcWidth` wide with round caps. */
  readonly arc: string;
  readonly arcOpacity: number;
  readonly arcWidth: number;
  /** In the body's frame; filled in the pupil's color. No mouth when `ry` is 0. */
  readonly mouth: {
    readonly cx: number;
    readonly cy: number;
    readonly rx: number;
    readonly ry: number;
  };
  /** Stroked in the body's color, `stalkWidth` wide with round caps. */
  readonly stalk: string;
  readonly stalkWidth: number;
  readonly light: AvatarCircle;
  /** A ring about the light in the light's color, `haloOpacity` strong; nothing drawn at 0. */
  readonly halo: AvatarCircle;
  readonly haloOpacity: number;
  /**
   * The radius of a disc about the light in the color of what the avatar sits
   * on, under a light in a state's color: a band around it, so it stands
   * clear of the body and the stalk whatever their color. 0, nothing drawn,
   * for a light in the body's color, which is the antenna's own tip.
   */
  readonly lightCut: number;
  /** Places the signal at the light. */
  readonly signal: AvatarMatrix;
  /** Turns the working ring about the light. */
  readonly ring: AvatarMatrix;
}

/**
 * The signals' geometry about the light, drawn in the body's color, 2.6 wide
 * with round caps; the waiting ping takes the waiting color.
 */
export const avatarSignals = {
  stroke: 2.6,
  /** A dashed ring that turns while the bot works. */
  ring: { r: 8.6, dash: [5.2, 3.8] },
  /** The waiting ping: a ring that spreads from `from` to `from + spread` and fades. */
  ping: { from: 6, spread: 9 },
  /** Two sound arcs, inner and outer, while the bot speaks. */
  arcs: ["M5.5 -6.6A8.6 8.6 0 0 1 8.5 1.5", "M8.6 -10.2A13.4 13.4 0 0 1 13.2 2.3"],
  /** Two thought dots rising off the light: filled. */
  dots: [
    { x: 7.5, y: -7, r: 2.8 },
    { x: 13, y: -13, r: 2.1 },
  ],
} as const;

/** The body's feet, which it leans and squashes about. */
const FEET = { x: 50, y: 94 } as const;

function fixed(n: number): number {
  "worklet";
  return Math.round(n * 100) / 100;
}

/** `n` on the nearest multiple of `step`, written short. */
function onStep(n: number, step: number): number {
  "worklet";
  return Math.round(Math.round(n / step) * step * 10_000) / 10_000;
}

/**
 * A circle's part on one side of the horizontal line `y = chord`: above it
 * when `above`, else below. All of the circle past an edge, nothing short of it.
 */
function segment(r: number, chord: number, above: boolean): string {
  "worklet";
  const covered = above ? chord + r : r - chord;
  if (covered <= 0) return "";
  if (covered >= 2 * r) return `M${-r} 0A${r} ${r} 0 1 1 ${r} 0A${r} ${r} 0 1 1 ${-r} 0Z`;
  const w = fixed(Math.sqrt(r * r - chord * chord));
  const y = fixed(chord);
  const large = covered > r ? 1 : 0;
  return above
    ? `M${-w} ${y}A${r} ${r} 0 ${large} 1 ${w} ${y}Z`
    : `M${w} ${y}A${r} ${r} 0 ${large} 1 ${-w} ${y}Z`;
}

/** The part of the circle about (0, 0) of radius `outer` that the circle about (0, `cy`) of radius `r` covers. */
function overlap(outer: number, cy: number, r: number): string {
  "worklet";
  if (cy >= outer + r) return "";
  const y0 = (outer * outer - r * r + cy * cy) / (2 * cy);
  const x0 = Math.sqrt(Math.max(0, outer * outer - y0 * y0));
  const upper = y0 > cy ? 1 : 0;
  const lower = y0 < 0 ? 1 : 0;
  const x = fixed(x0);
  const y = fixed(y0);
  return `M${-x} ${y}A${r} ${r} 0 ${upper} 1 ${x} ${y}A${outer} ${outer} 0 ${lower} 1 ${-x} ${y}Z`;
}

function clamp01(n: number): number {
  "worklet";
  return Math.min(1, Math.max(0, n));
}

/**
 * How a little one, a bot's small copy of itself, differs from the bot it came
 * out of: a larger eye set lower on the body, as a young face has, a larger
 * glint in it, and at the antenna's place a sprout with a round tip. Its body
 * is the bot's own silhouette, drawn lighter with a rim of the bot's color
 * (`littleOutline` wider than the body's own outline).
 */
export const littleFace = { eye: 1.16, eyeDrop: 3, glint: 0.34, light: 5.6, outline: 5 } as const;

/**
 * The geometry of `face` on `shape`, for an avatar `px` px wide; `little` for
 * one of a bot's little ones (`littleFace`). Pure, and a worklet, so the
 * mobile app runs it on the UI thread.
 *
 * Every length is rounded to a quarter of a pixel at `px`, and every turn or
 * scale to what moves a point at the body's edge that far: finer than anyone
 * sees, and coarse enough that a part at rest, or moving less than that,
 * keeps the same numbers frame after frame, so a renderer can leave it alone.
 */
export function avatarFrame(
  shapeName: AvatarShapeName,
  face: AvatarFace,
  px: number,
  little = false,
): AvatarFrame {
  "worklet";
  const shape = avatarShapes[shapeName];
  const small = px <= AVATAR_SMALL;
  const R = AVATAR_EYE;
  const grain = 25 / px;
  const length = (n: number) => onStep(n, grain);
  // A turn or scale of this much moves a point 50 units out, the body's reach from its feet, by the grain.
  const turnOf = (n: number) => onStep(n, grain / 50);

  // The body: a squash or a stretch about its feet, a lean, and its rise off the ground.
  // What it loses in height it gains in width, and the other way when it stretches.
  const swell = 1 + face.swell;
  const sy = (1 + face.breath - face.squash) * swell;
  const sx =
    (1 - face.breath * 0.6 + face.squash * 0.5 + Math.max(0, face.squash - 0.07) * 0.35) * swell;
  const t = (face.tilt * Math.PI) / 180;
  const a = turnOf(Math.cos(t) * sx);
  const b = turnOf(Math.sin(t) * sx);
  const c = turnOf(-Math.sin(t) * sy);
  const d = turnOf(Math.cos(t) * sy);
  const rise = face.hop + face.bob;
  const body: AvatarMatrix = [
    a,
    b,
    c,
    d,
    length(FEET.x - (a * FEET.x + c * FEET.y)),
    length(rise + FEET.y - (b * FEET.x + d * FEET.y)),
  ];

  // The eye: lids from the blink, a shut eye, or the pose, whichever closes it most.
  const scale = shape.eyeScale * (small ? 1.24 : 1) * (little ? littleFace.eye : 1);
  const eyeY = length(shape.eye.y + face.eyeLift + (little ? littleFace.eyeDrop : 0));
  const eye: AvatarMatrix = [scale, 0, 0, scale, shape.eye.x, eyeY];
  const shutLids = Math.min(1, face.shut * 2);
  const top = length(-R + Math.max(face.lidTop, face.blink, shutLids) * R);
  const bottom = length(R - Math.max(face.lidBottom, face.blink * 0.85, shutLids) * R);
  const pupil = length(face.pupil);
  const reach = R - pupil - 1.2;
  const px0 = length(face.gazeX * reach);
  const py0 = length(face.gazeY * reach);
  const lid = R + 0.6;
  const k = length(face.curve);
  const roll = turnOf((face.roll * Math.PI) / 180);
  const turn = (x: number, y: number) =>
    `${fixed(x * Math.cos(roll) - y * Math.sin(roll))} ${fixed(x * Math.sin(roll) + y * Math.cos(roll))}`;

  // The antenna, its tip trailing the body by the lag.
  const angle = (face.antennaAngle * Math.PI) / 180;
  const root = shape.antenna;
  const tipX = length(root.x + Math.sin(angle) * face.antennaLength + face.lagX);
  const tipY = length(root.y - Math.cos(angle) * face.antennaLength + face.lagY);
  const signalScale = small ? 1.25 : 1;
  const lightR = length((little ? littleFace.light : small ? 6.4 : 4.8) * face.lightScale);
  const ring = turnOf((face.ring * Math.PI) / 180);

  return {
    body,
    eye,
    open: face.shut < 0.5,
    pupil: { x: px0, y: py0, r: pupil },
    // A little one keeps its glint at any size: it is most of what makes its eye a young one.
    glint:
      small && !little
        ? null
        : {
            x: length(px0 + pupil * 0.36),
            y: length(py0 - pupil * 0.38),
            r: length(pupil * (little ? littleFace.glint : 0.27)),
          },
    cheek: overlap(lid, length(R * 2 + 3 + (R + 2.4 - (R * 2 + 3)) * face.cheek), R + 1),
    upperLid: segment(lid, top, true),
    lowerLid: segment(lid, bottom, false),
    arc: `M${turn(-10.5, k * 0.45)}Q${turn(0, -k)} ${turn(10.5, k * 0.45)}`,
    arcOpacity: onStep(clamp01((face.shut - 0.5) * 2), 1 / 32),
    arcWidth: small ? 5 : 3.8,
    mouth: {
      cx: shape.eye.x,
      cy: length(eyeY + R * scale + 6.5),
      rx: 5.2,
      ry: length(face.mouth * 4.6),
    },
    stalk: `M${root.x} ${root.y + 4}Q${root.x} ${length(root.y - face.antennaLength * 0.62)} ${tipX} ${tipY}`,
    stalkWidth: small ? 5.5 : 4,
    light: { x: tipX, y: tipY, r: lightR },
    halo: { x: tipX, y: tipY, r: length(lightR * (1.5 + 1.7 * face.glow)) },
    haloOpacity: onStep(clamp01(face.glow) * 0.55, 1 / 32),
    lightCut: face.light === "body" ? 0 : length(lightR + (small ? 4 : 2.6)),
    signal: [signalScale, 0, 0, signalScale, tipX, tipY],
    ring: [Math.cos(ring), Math.sin(ring), -Math.sin(ring), Math.cos(ring), 0, 0],
  };
}

/** A matrix as SVG writes it. */
export const matrixAttribute = (m: AvatarMatrix): string =>
  `matrix(${m.map((n) => Math.round(n * 10_000) / 10_000).join(" ")})`;

/**
 * The three bots that stand for the team on screens where it is still to
 * come: the first three of the cast, the middle one larger, sizes in px.
 */
export const avatarEnsemble = avatarCast
  .slice(0, 3)
  .map((avatar, index) => ({ avatar, size: index === 1 ? 56 : 40 }));

/**
 * A room's avatar overlaps its first two members, each this share of the
 * box's side: the first at the top left, the second over it at the bottom right.
 */
export const roomAvatarShare = 0.68;

const isShape = (token: string): token is AvatarShapeName =>
  (avatarShapeNames as ReadonlyArray<string>).includes(token);
const isColor = (token: string): token is BotColor =>
  (botColors as ReadonlyArray<string>).includes(token);

/**
 * An avatar's tokens as this version can draw them. A token it does not
 * know, from a newer server, falls back instead of failing: a dome in slate.
 */
export function resolveAvatar(avatar: { readonly shape: string; readonly color: string }): {
  readonly shape: AvatarShapeName;
  readonly color: BotColor;
} {
  return {
    shape: isShape(avatar.shape) ? avatar.shape : "dome",
    color: isColor(avatar.color) ? avatar.color : "slate",
  };
}
