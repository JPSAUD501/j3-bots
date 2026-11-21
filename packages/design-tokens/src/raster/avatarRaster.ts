// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Avatars as pixels: the still form of `avatar.ts` drawn onto a `Canvas`, for
 * images that cannot be SVG, such as app icons and notification images.
 */
import {
  avatarBadges,
  avatarMarks,
  avatarMarkStroke,
  avatarProportions,
  avatarShapeCutout,
  resolveAvatar,
  roomAvatarShare,
  type AvatarLook,
  type AvatarMarkPart,
} from "../avatar.ts";
import { avatarShapes } from "../avatarShapes.ts";
import { parseColor, toSrgb8 } from "../color.ts";
import {
  Canvas,
  circlePath,
  flattenPath,
  isPixelCount,
  mapSubpaths,
  type Point,
  type Rgb,
} from "./canvas.ts";
import { botPalette, colors, type Themed } from "../tokens.ts";

const srgb = (value: string): Rgb => toSrgb8(parseColor(value));

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

/**
 * Draws a still avatar into `box` on `canvas`, in `theme`'s colors. The
 * badge's cutout clears what is under it, so on a clear canvas the badge
 * stands apart from the shape as it does on any page.
 */
export function drawAvatar(
  canvas: Canvas,
  avatar: AvatarTokens,
  look: AvatarLook,
  theme: keyof Themed,
  box: AvatarBox,
) {
  const { shape: shapeName, color } = resolveAvatar(avatar);
  const shape = avatarShapes[shapeName];
  const unit = box.size / 100;
  const { markScale, badge } = avatarProportions(box.size);
  const toCanvas = (p: Point): Point => ({ x: box.x + p.x * unit, y: box.y + p.y * unit });
  canvas.fill(mapSubpaths(flattenPath(shape.path), toCanvas), srgb(botPalette[color][theme]));

  const ink = srgb(colors["avatar-ink"][theme]);
  const markCenter = toCanvas(shape.mark);
  const markUnit = markScale * unit;
  const parts: ReadonlyArray<AvatarMarkPart> = avatarMarks[look.mark];
  for (const part of parts) {
    switch (part.kind) {
      case "disc":
        canvas.fill(circlePath(markCenter, part.r * markUnit), ink);
        break;
      case "circle":
        canvas.stroke(circlePath(markCenter, part.r * markUnit), avatarMarkStroke * markUnit, ink, {
          ...(part.opacity === undefined ? {} : { opacity: part.opacity }),
          ...(part.dash === undefined
            ? {}
            : { dash: [part.dash[0] * markUnit, part.dash[1] * markUnit] }),
        });
        break;
      case "path": {
        const toMark = (p: Point): Point => ({
          x: markCenter.x + p.x * markUnit,
          y: markCenter.y + p.y * markUnit,
        });
        canvas.stroke(mapSubpaths(flattenPath(part.d), toMark), avatarMarkStroke * markUnit, ink);
        break;
      }
    }
  }

  if (look.badge !== null) {
    const center = toCanvas({ x: badge.center, y: badge.center });
    canvas.clear(circlePath(center, (badge.r + badge.cutout / 2) * unit));
    canvas.fill(
      circlePath(center, (badge.r - badge.cutout / 2) * unit),
      srgb(colors[avatarBadges[look.badge]][theme]),
    );
  }
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
 * `theme`'s colors: for a notification's image, where SVG is not accepted.
 * `size` is a whole number of px, at least 1; anything else throws a `RangeError`.
 */
export function renderStillAvatar(
  avatar: AvatarTokens,
  look: AvatarLook,
  theme: keyof Themed,
  size: number,
): Uint8Array<ArrayBuffer> {
  const canvas = stillCanvas(size);
  drawAvatar(canvas, avatar, look, theme, { x: 0, y: 0, size });
  return canvas.png();
}

/** A shape alone, with no mark, cut out of what it overlaps. */
function drawShape(canvas: Canvas, avatar: AvatarTokens, theme: keyof Themed, box: AvatarBox) {
  const { shape, color } = resolveAvatar(avatar);
  const unit = box.size / 100;
  const outline = mapSubpaths(flattenPath(avatarShapes[shape].path), (p) => ({
    x: box.x + p.x * unit,
    y: box.y + p.y * unit,
  }));
  canvas.clear(outline, avatarShapeCutout * unit);
  canvas.fill(outline, srgb(botPalette[color][theme]));
}

/**
 * A still room avatar as a PNG `size` px square on a clear background, in
 * `theme`'s colors: its first two members' shapes, overlapping, with no mark,
 * as a room shows anywhere. A member missing leaves its place clear. `size`
 * is a whole number of px, at least 1; anything else throws a `RangeError`.
 */
export function renderStillRoomAvatar(
  members: ReadonlyArray<AvatarTokens>,
  theme: keyof Themed,
  size: number,
): Uint8Array<ArrayBuffer> {
  const canvas = stillCanvas(size);
  const part = size * roomAvatarShare;
  const [back, front] = members;
  if (back !== undefined) drawShape(canvas, back, theme, { x: 0, y: 0, size: part });
  if (front !== undefined) {
    drawShape(canvas, front, theme, { x: size - part, y: size - part, size: part });
  }
  return canvas.png();
}
