// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The app's icons and the tray's, drawn from the icon art (`iconArt`): its
 * Pip on its plate, or the Pip whole where there is no plate. Each
 * platform's icon is one of the forms below; which one, at what size, is the
 * caller's.
 */
import { iconArt, type IconArt, type IconFrame } from "../appIconArt.ts";
import { avatarViewBox } from "../avatar.ts";
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
  // A silhouette leaves out the light's signal, which at a status bar's size is noise.
  const drawn: IconArt = silhouette ? { ...art, face: { ...art.face, signal: null } } : art;
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
 * The tray's icon as a PNG `size` px square on a clear background: the Pip
 * whole in `theme`, the one the system draws its tray in, its light lit in
 * the waiting color while something waits on the operator. A `size` that is
 * not a whole number of px, at least 1, throws a `RangeError`.
 */
export function renderTrayIcon(attention: boolean, theme: keyof Themed, size: number) {
  if (!isPixelCount(size)) {
    throw new RangeError(`An icon's size is a whole number of px, at least 1, not ${size}.`);
  }
  const canvas = new Canvas(size, size);
  const art: IconArt = {
    ...iconArt,
    face: { ...iconArt.face, light: attention ? "waiting" : "body", signal: null },
  };
  drawFramed(canvas, art, art.whole, size, theme, {});
  return canvas.png();
}
