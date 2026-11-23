// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The app's icons and the tray's, drawn from the icon art (`iconArt`): three
 * bots on the canvas color, or the largest alone where the row would be too
 * small to read. Each platform's icon is one of the forms below; which one,
 * at what size, is the caller's.
 */
import {
  ICON_DOT,
  iconArt,
  iconBadge,
  iconDotScale,
  iconInk,
  iconLead,
  layOutIcon,
  type IconBot,
  type IconLayout,
} from "../appIconArt.ts";
import { parseColor, toSrgb8 } from "../color.ts";
import { colors, type Themed } from "../tokens.ts";
import {
  Canvas,
  circlePath,
  flattenPath,
  isPixelCount,
  mapSubpaths,
  type Point,
  type Rgb,
} from "./canvas.ts";

/** What lies under the bots. */
export type AppIconPlate =
  /** Nothing: the system draws its own background, or none. */
  | { readonly kind: "none" }
  /** The canvas color over the whole square, for a system that cuts the icon's outline itself. */
  | { readonly kind: "square" }
  /**
   * A square of the canvas color with rounded corners, inset by `inset` of
   * the side on every edge, for a system that shows the icon as given.
   */
  | { readonly kind: "rounded"; readonly inset: number };

export interface AppIcon {
  /** The image's side, in px: a whole number, at least 1. */
  readonly size: number;
  /** The bots' palette, and the canvas color of a plate. */
  readonly theme: keyof Themed;
  readonly plate: AppIconPlate;
  /** The whole row, or only its lead (`iconLead`). */
  readonly art: "ensemble" | "lead";
  /** The art's width, as a share of the image's side. */
  readonly width: number;
  /**
   * Every bot in white with its mark cut out, for an icon the system tints
   * from its alpha alone: Android's monochrome icon, iOS's tinted one.
   */
  readonly silhouette?: boolean;
}

/** The row's width on a plate, as a share of the plate's side. */
const ROW_ON_PLATE = 0.78;
/** The lead's width on a plate, alone where the row would be too small to read. */
const LEAD_ON_PLATE = 0.66;
/** The largest desktop icon, in px, that shows the lead alone. */
const LEAD_UP_TO = 48;
/** Linux and Windows show an icon as given: its plate is inset by a sixteenth. */
const DESKTOP_INSET = 1 / 16;
/** macOS's icon grid: a 824 px plate centered in 1024 px. */
const MAC_INSET = 100 / 1024;

/** The desktop app's icon on Linux and Windows, `size` px square. */
export const desktopIcon = (size: number): AppIcon => {
  const lead = size <= LEAD_UP_TO;
  return {
    size,
    theme: "light",
    plate: { kind: "rounded", inset: DESKTOP_INSET },
    art: lead ? "lead" : "ensemble",
    width: (lead ? LEAD_ON_PLATE : ROW_ON_PLATE) * (1 - 2 * DESKTOP_INSET),
  };
};

/** The desktop app's icon on macOS, on its icon grid, `size` px square. */
export const macIcon = (size: number): AppIcon => ({
  size,
  theme: "light",
  plate: { kind: "rounded", inset: MAC_INSET },
  art: "ensemble",
  width: ROW_ON_PLATE * (1 - 2 * MAC_INSET),
});

/** A rounded plate's corner radius, as a share of its side: the curve of a macOS or iOS icon. */
const PLATE_RADIUS = 0.2237;

const WHITE: Rgb = [255, 255, 255];

const layouts: Readonly<Record<AppIcon["art"], IconLayout>> = {
  ensemble: layOutIcon(iconArt.bots, iconArt.gap),
  lead: layOutIcon([iconLead], 0),
};

const srgb = (value: string): Rgb => toSrgb8(parseColor(value));

/** Where a bot lands on a canvas: its box's top left corner and its side, in px. */
interface IconBox {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/**
 * One bot of the art in `box`: its silhouette, its dot, and with `badge` the
 * tray's waiting badge, cut out of the bot by a clear outline.
 */
function drawIconBot(
  canvas: Canvas,
  bot: IconBot,
  theme: keyof Themed,
  box: IconBox,
  badge: boolean,
) {
  const unit = box.size / 100;
  const toCanvas = (p: Point): Point => ({ x: box.x + p.x * unit, y: box.y + p.y * unit });
  canvas.fill(mapSubpaths(flattenPath(bot.path), toCanvas), srgb(bot.color[theme]));
  canvas.fill(
    circlePath(toCanvas(bot.mark), ICON_DOT * iconDotScale(box.size) * unit),
    srgb(iconInk[theme]),
  );
  if (!badge) return;
  const { center, r, cutout } = iconBadge(box.size);
  const at = toCanvas({ x: center, y: center });
  canvas.clear(circlePath(at, (r + cutout / 2) * unit));
  canvas.fill(circlePath(at, (r - cutout / 2) * unit), srgb(colors.waiting[theme]));
}

/**
 * The tray's icon as a PNG `size` px square on a clear background: the art's
 * lead, with a badge when something waits on the operator. A `size` that is
 * not a whole number of px, at least 1, throws a `RangeError`.
 */
export function renderTrayIcon(attention: boolean, theme: keyof Themed, size: number) {
  if (!isPixelCount(size)) {
    throw new RangeError(`An icon's size is a whole number of px, at least 1, not ${size}.`);
  }
  const canvas = new Canvas(size, size);
  drawIconBot(canvas, iconLead, theme, { x: 0, y: 0, size }, attention);
  return canvas.png();
}

/** The subpaths of a square from `low` to `high` on both axes, its corners rounded by `r`. */
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

/**
 * The icon as a PNG. A `size` that is not a whole number of px, at least 1,
 * throws a `RangeError`.
 */
export function renderAppIcon(icon: AppIcon): Uint8Array<ArrayBuffer> {
  const { size, theme, plate, art, width, silhouette = false } = icon;
  if (!isPixelCount(size)) {
    throw new RangeError(`An icon's size is a whole number of px, at least 1, not ${size}.`);
  }
  const canvasColor = toSrgb8(parseColor(colors.background[theme]));
  const canvas = new Canvas(size, size, plate.kind === "square" ? canvasColor : undefined);
  if (plate.kind === "rounded") {
    const low = size * plate.inset;
    const high = size - low;
    canvas.fill(roundedSquare(low, high, (high - low) * PLATE_RADIUS), canvasColor);
  }

  const layout = layouts[art];
  const scale = (size * width) / layout.width;
  const origin: Point = {
    x: (size - layout.width * scale) / 2,
    y: (size - layout.height * scale) / 2,
  };
  for (const { bot, left, top } of layout.placed) {
    const box = {
      x: origin.x + left * scale,
      y: origin.y + top * scale,
      size: bot.size * scale,
    };
    if (!silhouette) {
      drawIconBot(canvas, bot, theme, box, false);
      continue;
    }
    const unit = box.size / 100;
    const toCanvas = (p: Point): Point => ({ x: box.x + p.x * unit, y: box.y + p.y * unit });
    canvas.fill(mapSubpaths(flattenPath(bot.path), toCanvas), WHITE);
    canvas.clear(circlePath(toCanvas(bot.mark), ICON_DOT * iconDotScale(box.size) * unit));
  }
  return canvas.png();
}
