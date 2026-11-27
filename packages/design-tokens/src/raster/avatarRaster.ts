// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Avatars as pixels: one face of `avatar.ts` drawn onto a `Canvas`, for
 * images that cannot be SVG, such as notification images. The face is the
 * caller's: a still form from the client runtime (`stillFace`).
 */
import {
  AVATAR_EYE,
  avatarFrame,
  avatarSignals,
  avatarViewBox,
  resolveAvatar,
  roomAvatarShare,
  type AvatarFace,
  type AvatarMatrix,
} from "../avatar.ts";
import { avatarShapes } from "../avatarShapes.ts";
import { avatarEye, botPalette } from "../botPalette.ts";
import { parseColor, toSrgb8, type LinearRgb, washedOut } from "../color.ts";
import { colors, type Themed } from "../tokens.ts";
import {
  Canvas,
  flattenPath,
  isPixelCount,
  mapSubpaths,
  type Point,
  type Rgb,
  type Subpath,
} from "./canvas.ts";

/** An avatar's tokens: its shape and its color. */
interface AvatarTokens {
  readonly shape: string;
  readonly color: string;
}

/** Where an avatar lands on a canvas: its box's top left corner and its side, in px. */
export interface AvatarBox {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

const srgb = (color: LinearRgb): Rgb => toSrgb8(color);

const apply = (m: AvatarMatrix, p: Point): Point => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});

const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
  `M${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}Z`;

const circle = (x: number, y: number, r: number) => ellipse(x, y, r, r);

/**
 * Draws `face` into `box` on `canvas`, in `theme`'s colors. A still image has
 * nothing to fade into, so an offline bot keeps its parts opaque and only
 * loses its color. `shownAt` is the size it shows at, in px, when that is not
 * the box's: drawn on a screen of more pixels than px, it takes the
 * proportions of its size on screen, as an avatar of 28 px and under draws
 * its eye larger.
 */
export function drawAvatar(
  canvas: Canvas,
  avatar: AvatarTokens,
  face: AvatarFace,
  theme: keyof Themed,
  box: AvatarBox,
  shownAt: number = box.size,
) {
  const { shape: shapeName, color } = resolveAvatar(avatar);
  const shape = avatarShapes[shapeName];
  const frame = avatarFrame(shapeName, face, shownAt);
  const unit = box.size / avatarViewBox.size;
  const toBox = (p: Point): Point => ({
    x: box.x + (p.x - avatarViewBox.x) * unit,
    y: box.y + (p.y - avatarViewBox.y) * unit,
  });
  const onBody = (d: string): ReadonlyArray<Subpath> =>
    mapSubpaths(flattenPath(d), (p) => toBox(apply(frame.body, p)));
  const onEye = (d: string): ReadonlyArray<Subpath> =>
    mapSubpaths(flattenPath(d), (p) => toBox(apply(frame.body, apply(frame.eye, p))));
  const onSignal = (d: string, turn?: AvatarMatrix): ReadonlyArray<Subpath> =>
    mapSubpaths(flattenPath(d), (p) =>
      toBox(apply(frame.body, apply(frame.signal, turn === undefined ? p : apply(turn, p)))),
    );
  const tone = (value: string): Rgb => {
    const parsed = parseColor(value);
    return srgb(face.asleep ? washedOut(parsed) : parsed);
  };
  const bodyColor = tone(botPalette[color][theme]);
  const lens = tone(avatarEye.lens);
  const pupil = tone(avatarEye.pupil);
  // The eye scales with the body's frame: strokes on it are as wide as the box draws them.
  const eyeUnit = unit * frame.eye[0];

  canvas.stroke(onBody(frame.stalk), frame.stalkWidth * unit, bodyColor);
  const body = onBody(shape.path);
  canvas.fill(body, bodyColor);
  canvas.stroke(body, shape.outline * unit, bodyColor);

  if (frame.open) {
    canvas.fill(onEye(circle(0, 0, AVATAR_EYE)), lens);
    canvas.fill(onEye(circle(frame.pupil.x, frame.pupil.y, frame.pupil.r)), pupil);
    if (frame.glint !== null) {
      canvas.fill(onEye(circle(frame.glint.x, frame.glint.y, frame.glint.r)), lens);
    }
    for (const cover of [frame.cheek, frame.upperLid, frame.lowerLid]) {
      if (cover !== "") canvas.fill(onEye(cover), bodyColor);
    }
  }
  if (frame.arcOpacity > 0) {
    canvas.stroke(onEye(frame.arc), frame.arcWidth * eyeUnit, lens, { opacity: frame.arcOpacity });
  }
  if (frame.mouth.ry > 0) {
    const { cx, cy, rx, ry } = frame.mouth;
    // The mouth is drawn in the pupil's color, on the body.
    canvas.fill(onBody(ellipse(cx, cy, rx, ry)), pupil);
  }

  const { x, y, r } = frame.light;
  // A status light stands in a clear cutout of the body.
  if (frame.lightCut > 0) canvas.clear(onBody(circle(x, y, frame.lightCut)));

  const signalWidth = avatarSignals.stroke * unit * frame.signal[0];
  switch (face.signal) {
    case "ring":
      canvas.stroke(
        onSignal(circle(0, 0, avatarSignals.ring.r), frame.ring),
        signalWidth,
        bodyColor,
        {
          dash: [avatarSignals.ring.dash[0] * unit, avatarSignals.ring.dash[1] * unit],
        },
      );
      break;
    case "ping":
      canvas.stroke(
        onSignal(circle(0, 0, avatarSignals.ping.from + face.ping * avatarSignals.ping.spread)),
        signalWidth,
        tone(colors.waiting[theme]),
        { opacity: face.pingOpacity },
      );
      break;
    case "arcs":
      avatarSignals.arcs.forEach((d, i) => {
        canvas.stroke(onSignal(d), signalWidth, bodyColor, { opacity: face.arcs[i] ?? 1 });
      });
      break;
    case "dots":
      avatarSignals.dots.forEach((dot, i) => {
        canvas.fill(onSignal(circle(dot.x, dot.y, dot.r * (face.dots[i] ?? 1))), bodyColor);
      });
      break;
    case null:
      break;
  }

  const light = face.light === "body" ? bodyColor : tone(colors[face.light][theme]);
  canvas.fill(onBody(circle(x, y, r)), light);
}

/**
 * A clear canvas `size` px square, for a still image. `size` is a whole
 * number of px, at least 1; anything else throws a `RangeError`.
 */
function stillCanvas(size: number): Canvas {
  if (!isPixelCount(size)) {
    throw new RangeError(`A still avatar's size is a whole number of px, at least 1, not ${size}.`);
  }
  return new Canvas(size, size);
}

/**
 * A still avatar as a PNG `size` px square on a clear background, in
 * `theme`'s colors: for a notification's image, or text a native field
 * draws, where SVG is not accepted. `size` is a whole number of px, at least
 * 1; anything else throws a `RangeError`. `shownAt`, when it differs, is the
 * size the image shows at on a screen of `size / shownAt` pixels per px,
 * whose proportions it takes.
 */
export function renderStillAvatar(
  avatar: AvatarTokens,
  face: AvatarFace,
  theme: keyof Themed,
  size: number,
  shownAt: number = size,
): Uint8Array<ArrayBuffer> {
  const canvas = stillCanvas(size);
  drawAvatar(canvas, avatar, face, theme, { x: 0, y: 0, size }, shownAt);
  return canvas.png();
}

/** How wide a clear band cuts a room's front member out of the one behind, in the 100-unit box. */
const ROOM_CUTOUT = 8;

/**
 * A still room avatar as a PNG `size` px square on a clear background, in
 * `theme`'s colors: its first two members, overlapping, each in `face`, as a
 * room shows anywhere. The front one is cut out of the one behind by a clear
 * band. A member missing leaves its place clear. `size` is a whole number of
 * px, at least 1; anything else throws a `RangeError`.
 */
export function renderStillRoomAvatar(
  members: ReadonlyArray<AvatarTokens>,
  face: AvatarFace,
  theme: keyof Themed,
  size: number,
): Uint8Array<ArrayBuffer> {
  const canvas = stillCanvas(size);
  const part = size * roomAvatarShare;
  const [back, front] = members;
  if (back !== undefined) drawAvatar(canvas, back, face, theme, { x: 0, y: 0, size: part });
  if (front !== undefined) {
    const box = { x: size - part, y: size - part, size: part };
    const shape = avatarShapes[resolveAvatar(front).shape];
    const unit = part / avatarViewBox.size;
    const outline = mapSubpaths(flattenPath(shape.path), (p) => ({
      x: box.x + (p.x - avatarViewBox.x) * unit,
      y: box.y + (p.y - avatarViewBox.y) * unit,
    }));
    canvas.clear(outline, (shape.outline + ROOM_CUTOUT) * unit);
    drawAvatar(canvas, front, face, theme, box);
  }
  return canvas.png();
}
