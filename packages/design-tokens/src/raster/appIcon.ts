// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The app's icons and the tray's, drawn from the icon art (`iconArt`): its
 * Pip on its plate, or the Pip whole where there is no plate. Each
 * platform's icon is one of the forms below; which one, at what size, is the
 * caller's.
 */
import { iconArt, type IconArt, type IconFrame } from "../appIconArt.ts";
import {
  AVATAR_SMALL,
  avatarFrame,
  avatarSignals,
  avatarViewBox,
  type AvatarFace,
} from "../avatar.ts";
import { parseColor, toSrgb8 } from "../color.ts";
import type { Themed } from "../tokens.ts";
import { drawAvatar, type AvatarPaint } from "./avatarRaster.ts";
import { Canvas, flattenPath, isPixelCount, type Rgb, type Subpath } from "./canvas.ts";

/** What lies under the art. */
export type AppIconPlate =
  /** Nothing: the system draws its own background, or none. */
  | { readonly kind: "none" }
  /** The plate's color over the whole square, for a system that cuts the icon's outline itself. */
  | { readonly kind: "square" }
  /**
   * A square of the plate's color with rounded corners, inset by `inset` of
   * the side on every edge, for a system that shows the icon as given. What
   * the art frames is cut to it.
   */
  | { readonly kind: "rounded"; readonly inset: number };

export interface AppIcon {
  /** The image's side, in px: a whole number, at least 1. */
  readonly size: number;
  readonly plate: AppIconPlate;
  /** The art as its plate frames it (`IconArt.frame`), or the Pip whole (`IconArt.whole`). */
  readonly framing: "plate" | "whole";
  /** The framed square's side, as a share of the image's, centered. */
  readonly width: number;
  /** The Pip's palette, where it is not the plate's: the Pip whole on a theme's canvas. */
  readonly theme?: keyof Themed;
  /**
   * The color the image is shown on, where it has no plate of its own: what a
   * status light's cutout takes. Clear without it, and with a plate the plate's.
   */
  readonly ground?: string;
  /**
   * The Pip in white with its lens and mouth cut out, for an icon the system
   * tints from its alpha alone: Android's monochrome and notification icons,
   * iOS's tinted one.
   */
  readonly silhouette?: boolean;
}

/** Linux and Windows show an icon as given: its plate is inset by a sixteenth. */
const DESKTOP_INSET = 1 / 16;
/** macOS's icon grid: a 824 px plate centered in 1024 px. */
const MAC_INSET = 100 / 1024;

/** The desktop app's icon on Linux and Windows, `size` px square. */
export const desktopIcon = (size: number): AppIcon => ({
  size,
  plate: { kind: "rounded", inset: DESKTOP_INSET },
  framing: "plate",
  width: 1 - 2 * DESKTOP_INSET,
});

/** The desktop app's icon on macOS, on its icon grid, `size` px square. */
export const macIcon = (size: number): AppIcon => ({
  size,
  plate: { kind: "rounded", inset: MAC_INSET },
  framing: "plate",
  width: 1 - 2 * MAC_INSET,
});

/** A rounded plate's corner radius, as a share of its side: the curve of a macOS or iOS icon. */
const PLATE_RADIUS = 0.2237;

const srgb = (value: string): Rgb => toSrgb8(parseColor(value));

/** The subpaths of a square from `low` to `high` on both axes, its corners rounded by `r`, clockwise. */
function roundedSquare(low: number, high: number, r: number) {
  const d = [
    `M${low + r} ${low}`,
    `L${high - r} ${low}`,
    `A${r} ${r} 0 0 1 ${high} ${low + r}`,
    `L${high} ${high - r}`,
    `A${r} ${r} 0 0 1 ${high - r} ${high}`,
    `L${low + r} ${high}`,
    `A${r} ${r} 0 0 1 ${low} ${high - r}`,
    `L${low} ${low + r}`,
    `A${r} ${r} 0 0 1 ${low + r} ${low}Z`,
  ].join("");
  return flattenPath(d);
}

/** A rounded plate's outline on an image `size` px square, inset by `inset` of the side. */
function plateOutline(size: number, inset: number) {
  const low = size * inset;
  const high = size - low;
  return roundedSquare(low, high, (high - low) * PLATE_RADIUS);
}

/**
 * An icon this many px square or smaller, the smallest a platform shows one
 * (a browser tab's favicon, the tray on macOS and Windows), grows the light at
 * its antenna's tip by `SMALL_LIGHT`. At its own size it is barely wider than
 * the stalk there and blurs into it, leaving a line over an eye; grown, it
 * stands apart as a knob, and the antenna reads as one.
 */
const SMALL_ICON = 16;
const SMALL_LIGHT = 1.5;

/** The art's pose for an image `size` px square. */
const poseAt = (face: AvatarFace, size: number): AvatarFace =>
  size <= SMALL_ICON ? { ...face, lightScale: face.lightScale * SMALL_LIGHT } : face;

/** The subpaths reversed: with the nonzero rule, a reversed shape inside another is a hole in it. */
const reversed = (subpaths: ReadonlyArray<Subpath>): ReadonlyArray<Subpath> =>
  subpaths.map(({ points, closed }) => ({ points: [...points].reverse(), closed }));

/** The Pip drawn on `canvas` so that `frame` spans `side` px of it, centered. */
function drawFramed(
  canvas: Canvas,
  art: IconArt,
  frame: IconFrame,
  side: number,
  theme: keyof Themed,
  paint: AvatarPaint,
) {
  const unit = side / frame.size;
  const left = (canvas.width - side) / 2;
  const top = (canvas.height - side) / 2;
  drawAvatar(
    canvas,
    art.avatar,
    art.face,
    theme,
    {
      x: left + (avatarViewBox.x - frame.x) * unit,
      y: top + (avatarViewBox.y - frame.y) * unit,
      size: avatarViewBox.size * unit,
    },
    paint,
  );
}

/**
 * The icon as a PNG, from `art`. A `size` that is not a whole number of px,
 * at least 1, throws a `RangeError`.
 */
export function renderAppIcon(icon: AppIcon, art: IconArt = iconArt): Uint8Array<ArrayBuffer> {
  const { size, plate, framing, width, silhouette = false } = icon;
  if (!isPixelCount(size)) {
    throw new RangeError(`An icon's size is a whole number of px, at least 1, not ${size}.`);
  }
  const plateColor = srgb(art.plate);
  const canvas = new Canvas(size, size, plate.kind === "square" ? plateColor : undefined);
  const outline = plate.kind === "rounded" ? plateOutline(size, plate.inset) : null;
  if (outline !== null) canvas.fill(outline, plateColor);
  const ground = plate.kind === "none" ? icon.ground : art.plate;
  const face = poseAt(art.face, size);
  // A silhouette leaves out the light's signal, which at a status bar's size is noise.
  const drawn: IconArt = { ...art, face: silhouette ? { ...face, signal: null } : face };
  drawFramed(
    canvas,
    drawn,
    framing === "plate" ? art.frame : art.whole,
    size * width,
    icon.theme ?? art.palette,
    { ...(ground === undefined ? {} : { ground: srgb(ground) }), silhouette },
  );
  // What the art frames past a rounded plate's edge is cut off at it.
  if (outline !== null) {
    canvas.clear([
      ...flattenPath(`M0 0L${size} 0L${size} ${size}L0 ${size}Z`),
      ...reversed(outline),
    ]);
  }
  return canvas.png();
}

/**
 * The tray's Pip while something waits on the operator: the waiting state's
 * still form, its eye wide, its antenna tall, its light grown and ringed in
 * the waiting color. It changes the tip's size and shape as well as its
 * color, since on Linux and Windows nothing beside the tray says it.
 */
const TRAY_ATTENTION = {
  lidTop: 0,
  lidBottom: 0,
  shut: 0,
  pupil: 8.6,
  antennaAngle: 0,
  antennaLength: 22,
  light: "waiting",
  lightScale: 1.8,
  signal: "ping",
  ping: 0.85,
  pingOpacity: 1,
} as const satisfies Partial<AvatarFace>;

/**
 * Room above the ring, in the avatar's units: over a px at the tray's
 * smallest, 16 px, so its edge stays clear of the image's.
 */
const TRAY_MARGIN = 9;

/** The tray's Pip, its light the body's own while nothing waits. */
const trayFace = (art: IconArt, attention: boolean): AvatarFace =>
  attention ? { ...art.face, ...TRAY_ATTENTION } : { ...art.face, light: "body", signal: null };

/**
 * The square the tray frames, the same in both states so the Pip stays put:
 * the Pip whole, grown upward until the attention form's ring and its
 * cutout fit, measured with a small avatar's proportions, the largest.
 */
function trayFrame(art: IconArt): IconFrame {
  const frame = avatarFrame(art.avatar.shape, trayFace(art, true), AVATAR_SMALL);
  const { from, spread } = avatarSignals.ping;
  // The ring's outer edge, from the light's center.
  const ring = (from + TRAY_ATTENTION.ping * spread + avatarSignals.stroke / 2) * frame.signal[0];
  const top = Math.min(art.whole.y, frame.light.y - Math.max(ring, frame.lightCut) - TRAY_MARGIN);
  const size = art.whole.y + art.whole.size - top;
  return { x: art.whole.x + (art.whole.size - size) / 2, y: top, size };
}

/**
 * The tray's icon as a PNG `size` px square on a clear background, from
 * `art`: the Pip whole in `theme`, the one the system draws its tray in, in
 * its attention form (`TRAY_ATTENTION`) while something waits on the
 * operator. A `size` that is not a whole number of px, at least 1, throws a
 * `RangeError`.
 */
export function renderTrayIcon(
  attention: boolean,
  theme: keyof Themed,
  size: number,
  art: IconArt = iconArt,
) {
  if (!isPixelCount(size)) {
    throw new RangeError(`An icon's size is a whole number of px, at least 1, not ${size}.`);
  }
  const canvas = new Canvas(size, size);
  const posed: IconArt = { ...art, face: poseAt(art.face, size) };
  drawFramed(canvas, { ...art, face: trayFace(posed, attention) }, trayFrame(art), size, theme, {});
  return canvas.png();
}
