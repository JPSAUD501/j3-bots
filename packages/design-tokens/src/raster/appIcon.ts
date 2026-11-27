// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The app's icons and the tray's, drawn from the icon art (`iconArt`): the
 * mark on its plate, or the mark alone where there is no plate. Each
 * platform's icon is one of the forms below; which one, at what size, is the
 * caller's.
 */
import { iconArt, type IconArt, type MarkDrawing } from "../appIconArt.ts";
import { parseColor, toSrgb8 } from "../color.ts";
import { colors, type Themed } from "../tokens.ts";
import {
  Canvas,
  flattenPath,
  isPixelCount,
  mapSubpaths,
  type Paint,
  type Point,
  type Rgb,
  type Subpath,
} from "./canvas.ts";

/** What lies under the mark. */
export type AppIconPlate =
  /** Nothing: the system draws its own background, or none. */
  | { readonly kind: "none" }
  /** The plate over the whole image, for a system that cuts the icon's outline itself. */
  | { readonly kind: "square" }
  /**
   * The plate as a square with rounded corners, inset by `inset` of the
   * image's side on every edge, for a system that shows the icon as given.
   */
  | { readonly kind: "rounded"; readonly inset: number };

export interface AppIcon {
  /** The image's side, in px: a whole number, at least 1. */
  readonly size: number;
  readonly plate: AppIconPlate;
  /**
   * What spans `width` of the image, centered: the plate's own square, in
   * which each drawing places the mark and which a shaded plate is shaded
   * across, or the mark alone, from edge to edge of what it draws.
   */
  readonly framing: "plate" | "mark";
  /** The framed square's side, as a share of the image's. */
  readonly width: number;
  /**
   * What is drawn over the plate. Without one, the mark in its colors.
   * `"silhouette"` is the mark in white, for an icon the system tints from
   * its alpha alone: Android's monochrome and notification icons, iOS's
   * tinted one. `"none"` leaves the plate alone, for a layer that lies under
   * a mark drawn apart.
   */
  readonly mark?: "silhouette" | "none";
  /**
   * The theme whose colors the mark takes where it stands on that theme's
   * canvas and not on a plate. The dark one without it, which is the plate's.
   */
  readonly theme?: keyof Themed;
}

/** Linux and Windows show an icon as given: its plate is inset by a sixteenth. */
const DESKTOP_INSET = 1 / 16;
/**
 * Below this side, in px, the plate fills the image: the sizes a taskbar, a
 * title bar, a menu or a browser's tab draws, where the mark's small drawings
 * are made for the whole square and a margin would take a px from each edge.
 */
const DESKTOP_MARGIN_FROM = 64;
/** macOS's icon grid: a 824 px plate centered in 1024 px. */
const MAC_INSET = 100 / 1024;

const rounded = (size: number, inset: number): AppIcon => ({
  size,
  plate: { kind: "rounded", inset },
  framing: "plate",
  width: 1 - 2 * inset,
});

/** The desktop app's icon on Linux and Windows, and the web's, `size` px square. */
export const desktopIcon = (size: number): AppIcon =>
  rounded(size, size < DESKTOP_MARGIN_FROM ? 0 : DESKTOP_INSET);

/** The desktop app's icon on macOS, on its icon grid, `size` px square. */
export const macIcon = (size: number): AppIcon => rounded(size, MAC_INSET);

/** A rounded plate's corner radius, as a share of its side: the curve of a macOS or iOS icon. */
const PLATE_RADIUS = 0.2237;

const srgb = (value: string): Rgb => toSrgb8(parseColor(value));

const WHITE: Rgb = [255, 255, 255];

/** A square of the image, in px: its top left corner and its side. */
interface Square {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** The subpaths of a square, its corners rounded by `r`, clockwise. */
function roundedSquare({ x, y, size }: Square, r: number) {
  const right = x + size;
  const bottom = y + size;
  return flattenPath(
    [
      `M${x + r} ${y}`,
      `L${right - r} ${y}`,
      `A${r} ${r} 0 0 1 ${right} ${y + r}`,
      `L${right} ${bottom - r}`,
      `A${r} ${r} 0 0 1 ${right - r} ${bottom}`,
      `L${x + r} ${bottom}`,
      `A${r} ${r} 0 0 1 ${x} ${bottom - r}`,
      `L${x} ${y + r}`,
      `A${r} ${r} 0 0 1 ${x + r} ${y}Z`,
    ].join(""),
  );
}

const circle = ({ x, y }: Point, r: number) =>
  flattenPath(`M${x - r} ${y}A${r} ${r} 0 1 1 ${x + r} ${y}A${r} ${r} 0 1 1 ${x - r} ${y}Z`);

/** The drawing an icon `size` px square takes: the largest made for a side no larger than its own. */
const drawingAt = (art: IconArt, size: number): MarkDrawing =>
  art.drawings.findLast((drawing) => size >= drawing.from) ?? art.drawings[0];

/** Where the letters' units land on an image: a point of them is at `x + scale * its x`, and so down. */
interface Placement {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** The mark where `drawing` places it on a plate whose square is `box`. */
function onPlate(art: IconArt, drawing: MarkDrawing, box: Square): Placement {
  const unit = box.size / 100;
  return {
    scale: unit * drawing.fit,
    x: box.x + (50 - art.middle.x * drawing.fit) * unit,
    y: box.y + (50 + drawing.drop - art.middle.y * drawing.fit) * unit,
  };
}

/**
 * The square that holds what the mark draws, in the letters' units: its
 * letters at the drawing's weight, and its light at `light`, its radius.
 */
function markBounds(art: IconArt, drawing: MarkDrawing, light: number): Square {
  const half = drawing.weight / 2;
  const points = art.letters.flatMap((letter) =>
    flattenPath(letter).flatMap((part) => part.points),
  );
  const left = Math.min(art.light.x - light, ...points.map((p) => p.x - half));
  const right = Math.max(art.light.x + light, ...points.map((p) => p.x + half));
  const top = Math.min(art.light.y - light, ...points.map((p) => p.y - half));
  const bottom = Math.max(art.light.y + light, ...points.map((p) => p.y + half));
  const size = Math.max(right - left, bottom - top);
  return { x: (left + right - size) / 2, y: (top + bottom - size) / 2, size };
}

/** The mark placed so that `bounds`, a square of the letters' units, is `box` on the image. */
const framed = (bounds: Square, box: Square): Placement => {
  const scale = box.size / bounds.size;
  return { scale, x: box.x - bounds.x * scale, y: box.y - bounds.y * scale };
};

/** The colors a mark is drawn in. */
interface MarkInk {
  readonly letters: Rgb;
  readonly light: Rgb;
  /** The glow's color, or `null` for none. */
  readonly glow: Rgb | null;
}

/** The mark's colors in `theme`, for `drawing`. A light glows on a dark ground only. */
const inkOf = (art: IconArt, drawing: MarkDrawing, theme: keyof Themed): MarkInk => ({
  letters: srgb(art.ink[theme]),
  light: srgb((drawing.bright ? art.light.bright : art.light.color)[theme]),
  glow: drawing.glow && theme === "dark" ? srgb(art.light.color[theme]) : null,
});

/** In white, with no glow: a system that tints an icon reads its alpha alone. */
const SILHOUETTE: MarkInk = { letters: WHITE, light: WHITE, glow: null };

/**
 * Draws the mark on `canvas` where `place` puts it: the glow under the
 * letters, the light over them, `light` its radius in the letters' units.
 * With `cut`, the letters are cleared that far around the light, so a light
 * grown over them still stands apart.
 */
function drawMark(
  canvas: Canvas,
  art: IconArt,
  drawing: MarkDrawing,
  place: Placement,
  ink: MarkInk,
  light: { readonly radius: number; readonly cut?: number } = { radius: drawing.light },
) {
  const onImage = (p: Point): Point => ({
    x: place.x + p.x * place.scale,
    y: place.y + p.y * place.scale,
  });
  const center = onImage(art.light);
  if (ink.glow !== null) {
    const radius = art.glow.radius * place.scale;
    canvas.fill(circle(center, radius), {
      kind: "radial",
      center,
      radius,
      stops: [
        { offset: 0, color: ink.glow, opacity: art.glow.opacity },
        { offset: 1, color: ink.glow, opacity: 0 },
      ],
    });
  }
  for (const letter of art.letters) {
    const outline: ReadonlyArray<Subpath> = mapSubpaths(flattenPath(letter), onImage);
    canvas.stroke(outline, drawing.weight * place.scale, ink.letters);
  }
  if (light.cut !== undefined) {
    canvas.clear(circle(center, (light.radius + light.cut) * place.scale));
  }
  canvas.fill(circle(center, light.radius * place.scale), ink.light);
}

/** The plate's paint for `drawing`: shaded down the plate's square, `box`, or flat. */
const platePaint = (art: IconArt, drawing: MarkDrawing, box: Square): Paint =>
  drawing.plate === "flat"
    ? srgb(art.plate.flat)
    : {
        kind: "linear",
        from: { x: box.x, y: box.y },
        to: { x: box.x, y: box.y + box.size },
        stops: [
          { offset: 0, color: srgb(art.plate.top) },
          { offset: 1, color: srgb(art.plate.bottom) },
        ],
      };

const sized = (size: number) => {
  if (!isPixelCount(size)) {
    throw new RangeError(`An icon's size is a whole number of px, at least 1, not ${size}.`);
  }
  return size;
};

/**
 * The icon as a PNG, in the drawing its size takes. A `size` that is not a
 * whole number of px, at least 1, throws a `RangeError`.
 */
export function renderAppIcon(icon: AppIcon, art: IconArt = iconArt): Uint8Array<ArrayBuffer> {
  const size = sized(icon.size);
  const { plate, framing, width, mark } = icon;
  const canvas = new Canvas(size, size);
  const drawing = drawingAt(art, size);
  const side = size * width;
  const box: Square = { x: (size - side) / 2, y: (size - side) / 2, size: side };
  if (plate.kind === "square") {
    canvas.fill(roundedSquare({ x: 0, y: 0, size }, 0), platePaint(art, drawing, box));
  }
  if (plate.kind === "rounded") {
    const outline: Square = { x: size * plate.inset, y: size * plate.inset, size: box.size };
    canvas.fill(roundedSquare(outline, outline.size * PLATE_RADIUS), platePaint(art, drawing, box));
  }
  if (mark === "none") return canvas.png();
  const place =
    framing === "plate"
      ? onPlate(art, drawing, box)
      : framed(markBounds(art, drawing, drawing.light), box);
  const theme = plate.kind === "none" ? (icon.theme ?? "dark") : "dark";
  drawMark(
    canvas,
    art,
    drawing,
    place,
    mark === "silhouette" ? SILHOUETTE : inkOf(art, drawing, theme),
  );
  return canvas.png();
}

/**
 * The tray's light while something waits on the operator: the waiting color,
 * grown by `grow`, with the letters cleared `cut` around it, in the letters'
 * units. It changes the light's size and the letters' shape as well as its
 * color, since on Linux and Windows nothing beside the tray says it.
 */
const TRAY_ATTENTION = { grow: 1.5, cut: 3.2 } as const;

/** How much of the tray's image the mark spans: the rest is the room a tray's icons keep around them. */
const TRAY_WIDTH = 0.92;

/**
 * The tray's icon as a PNG on a clear background: the mark alone in `theme`,
 * the one the system draws its tray in, its light in the waiting color and
 * grown (`TRAY_ATTENTION`) while something waits on the operator. It is
 * `size` px square on screen and `scale` pixels to the px, and takes the
 * drawing of its size on screen. The mark stands in the same place in both
 * states, framed to hold the grown light. Sides that are not a whole number
 * of px, at least 1, throw a `RangeError`.
 */
export function renderTrayIcon(
  attention: boolean,
  theme: keyof Themed,
  size: number,
  scale: number = 1,
  art: IconArt = iconArt,
) {
  const side = sized(sized(size) * scale);
  const canvas = new Canvas(side, side);
  const drawing = drawingAt(art, size);
  const grown = drawing.light * TRAY_ATTENTION.grow;
  const span = side * TRAY_WIDTH;
  const place = framed(markBounds(art, drawing, grown), {
    x: (side - span) / 2,
    y: (side - span) / 2,
    size: span,
  });
  const ink = inkOf(art, drawing, theme);
  if (attention) {
    drawMark(
      canvas,
      art,
      drawing,
      place,
      { ...ink, light: srgb(colors.waiting[theme]) },
      {
        radius: grown,
        cut: TRAY_ATTENTION.cut,
      },
    );
  } else {
    drawMark(canvas, art, drawing, place, ink);
  }
  return canvas.png();
}
