// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The app's icons, drawn from the ensemble (`ensemble`): the three idle bots
 * the first-run and pairing screens show, on the canvas color, or its lead
 * alone where the row would be too small to read. No art of its own: change
 * the avatars or the canvas and every icon follows. Each platform's icon is
 * one of the forms below; which one, at what size, is the caller's.
 */
import {
  avatarMarks,
  avatarProportions,
  ensemble,
  ensembleLead,
  layOutRow,
  type EnsembleLayout,
} from "../avatar.ts";
import { avatarShapes } from "../avatarShapes.ts";
import { parseColor, toSrgb8 } from "../color.ts";
import { colors, type Themed } from "../tokens.ts";
import { drawAvatar } from "./avatarRaster.ts";
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
  /** The whole ensemble, or only its lead (`ensembleLead`). */
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

const layouts: Readonly<Record<AppIcon["art"], EnsembleLayout>> = {
  ensemble: layOutRow(ensemble.members, ensemble.gap),
  lead: layOutRow([ensembleLead], 0),
};
const IDLE = { mark: "dot", badge: null } as const;

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
  for (const { member, left, top } of layout.placed) {
    const box = {
      x: origin.x + left * scale,
      y: origin.y + top * scale,
      size: member.size * scale,
    };
    if (!silhouette) {
      drawAvatar(canvas, member, IDLE, theme, box);
      continue;
    }
    const unit = box.size / 100;
    const toCanvas = (p: Point): Point => ({ x: box.x + p.x * unit, y: box.y + p.y * unit });
    const shape = avatarShapes[member.shape];
    canvas.fill(mapSubpaths(flattenPath(shape.path), toCanvas), WHITE);
    const [dot] = avatarMarks.dot;
    const { markScale } = avatarProportions(box.size);
    canvas.clear(circlePath(toCanvas(shape.mark), dot.r * markScale * unit));
  }
  return canvas.png();
}
