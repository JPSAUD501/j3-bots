// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Just enough vector rasterizing to turn avatars into PNG images, with no
 * image library, in Node and in a browser alike: SVG path data in the subset
 * the avatars use (absolute M, L, Q, A and Z), filled with the nonzero rule or
 * outlined with round caps and joins, anti-aliased, and an RGBA PNG encoder.
 */
import { zlibSync } from "fflate";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A piece of a path, as straight segments. A fill closes it either way. */
export interface Subpath {
  readonly points: ReadonlyArray<Point>;
  readonly closed: boolean;
}

/** Segments per curve. Plenty at icon sizes, where a segment spans a few pixels at most. */
const CURVE_STEPS = 32;

/** The path's subpaths, each flattened to straight segments. */
export function flattenPath(d: string): ReadonlyArray<Subpath> {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let index = 0;
  const number = (): number => {
    const token = tokens[index++];
    const value = Number(token);
    if (token === undefined || Number.isNaN(value)) throw new Error(`Expected a number in "${d}".`);
    return value;
  };
  const subpaths: Array<Subpath> = [];
  let points: Array<Point> = [];
  let current: Point = { x: 0, y: 0 };
  let command = "";
  while (index < tokens.length) {
    const token = tokens[index];
    if (token !== undefined && /[A-Za-z]/.test(token)) {
      command = token;
      index++;
    }
    switch (command) {
      case "M":
        if (points.length > 0) subpaths.push({ points, closed: false });
        current = { x: number(), y: number() };
        points = [current];
        // Further pairs after a move are lines.
        command = "L";
        break;
      case "L":
        current = { x: number(), y: number() };
        points.push(current);
        break;
      case "Q": {
        const control = { x: number(), y: number() };
        const end = { x: number(), y: number() };
        const start = current;
        for (let step = 1; step <= CURVE_STEPS; step++) {
          const t = step / CURVE_STEPS;
          const u = 1 - t;
          points.push({
            x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
            y: u * u * start.y + 2 * u * t * control.y + t * t * end.y,
          });
        }
        current = end;
        break;
      }
      case "A": {
        const rx = number();
        const ry = number();
        const rotation = number();
        const large = number() !== 0;
        const sweep = number() !== 0;
        const end = { x: number(), y: number() };
        points.push(...arcPoints(current, end, rx, ry, rotation, large, sweep));
        current = end;
        break;
      }
      case "Z":
        if (points.length > 0) subpaths.push({ points, closed: true });
        points = [];
        command = "";
        break;
      default:
        throw new Error(`Unsupported path command "${command}" in "${d}".`);
    }
  }
  if (points.length > 0) subpaths.push({ points, closed: false });
  return subpaths;
}

/** A circle as a path of one closed subpath, starting at its right and running clockwise, as SVG draws one. */
export function circlePath(center: Point, radius: number): ReadonlyArray<Subpath> {
  const steps = 64;
  const points = Array.from({ length: steps }, (_, i) => ({
    x: center.x + radius * Math.cos((2 * Math.PI * i) / steps),
    y: center.y + radius * Math.sin((2 * Math.PI * i) / steps),
  }));
  return [{ points, closed: true }];
}

/** The subpaths with `map` applied to every point. */
export function mapSubpaths(
  subpaths: ReadonlyArray<Subpath>,
  map: (point: Point) => Point,
): ReadonlyArray<Subpath> {
  return subpaths.map(({ points, closed }) => ({ points: points.map(map), closed }));
}

/** An elliptical arc as points, by the endpoint-to-center conversion of SVG 1.1, appendix F.6.5. */
function arcPoints(
  from: Point,
  to: Point,
  radiusX: number,
  radiusY: number,
  rotationDegrees: number,
  large: boolean,
  sweep: boolean,
): ReadonlyArray<Point> {
  if (radiusX === 0 || radiusY === 0) return [to];
  const phi = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  let rx = Math.abs(radiusX);
  let ry = Math.abs(radiusY);
  // Radii too small to reach the end point are scaled up until they do.
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cx1 = (factor * rx * y1) / ry;
  const cy1 = (-factor * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil((Math.abs(delta) / (2 * Math.PI)) * CURVE_STEPS * 2));
  return Array.from({ length: steps }, (_, i) => {
    const theta = start + (delta * (i + 1)) / steps;
    const ex = rx * Math.cos(theta);
    const ey = ry * Math.sin(theta);
    return { x: cos * ex - sin * ey + cx, y: sin * ex + cos * ey + cy };
  });
}

/** Sub-rows sampled per pixel row; horizontal coverage is computed exactly. */
const SAMPLES = 5;

/**
 * How much of each pixel of a `width` × `height` image the subpaths cover,
 * from 0 to 1, filled with the nonzero rule as SVG fills a path by default.
 */
export function coverage(
  subpaths: ReadonlyArray<Subpath>,
  width: number,
  height: number,
): Float32Array<ArrayBuffer> {
  const result = new Float32Array(width * height);
  const edges = subpaths.flatMap(({ points }) =>
    points.map((a, i) => {
      const b = points[(i + 1) % points.length] ?? a;
      return { a, b };
    }),
  );
  // Only the rows the path spans can be covered.
  const ys = edges.map(({ a }) => a.y);
  const firstRow = Math.max(0, Math.floor(Math.min(...ys)));
  const endRow = Math.min(height, Math.ceil(Math.max(...ys)));
  for (let row = firstRow; row < endRow; row++) {
    for (let sample = 0; sample < SAMPLES; sample++) {
      const y = row + (sample + 0.5) / SAMPLES;
      const crossings: Array<{ readonly x: number; readonly winding: number }> = [];
      for (const { a, b } of edges) {
        if (a.y === b.y || y < Math.min(a.y, b.y) || y >= Math.max(a.y, b.y)) continue;
        const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
        crossings.push({ x, winding: b.y > a.y ? 1 : -1 });
      }
      crossings.sort((p, q) => p.x - q.x);
      let winding = 0;
      for (let i = 0; i < crossings.length - 1; i++) {
        const crossing = crossings[i];
        const next = crossings[i + 1];
        if (crossing === undefined || next === undefined) continue;
        winding += crossing.winding;
        if (winding !== 0) addSpan(result, row * width, width, crossing.x, next.x);
      }
    }
  }
  for (let i = firstRow * width; i < endRow * width; i++) {
    result[i] = Math.min(1, (result[i] ?? 0) / SAMPLES);
  }
  return result;
}

/** Adds one sub-row's span from `from` to `to` to the row starting at `offset`. */
function addSpan(target: Float32Array, offset: number, width: number, from: number, to: number) {
  const start = Math.max(0, from);
  const end = Math.min(width, to);
  if (end <= start) return;
  const first = Math.floor(start);
  const last = Math.min(width - 1, Math.floor(end));
  for (let x = first; x <= last; x++) {
    const covered = Math.min(end, x + 1) - Math.max(start, x);
    if (covered > 0) target[offset + x] = (target[offset + x] ?? 0) + covered;
  }
}

/**
 * How much of each pixel of a `width` × `height` image the subpaths' outlines
 * cover, from 0 to 1, for an outline `lineWidth` wide with round caps and
 * joins. With `dash`, one dash and one gap, the outline is dashed from each
 * subpath's start; a pattern of zeros leaves it solid, as in SVG.
 */
function strokeCoverage(
  subpaths: ReadonlyArray<Subpath>,
  lineWidth: number,
  width: number,
  height: number,
  dash?: readonly [number, number],
): Float32Array<ArrayBuffer> {
  const half = lineWidth / 2;
  // A round-capped, round-joined outline is every point within half its width
  // of the line, so each pixel's coverage follows from its center's distance.
  const nearest = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);
  for (const subpath of subpaths) {
    const line = subpath.closed
      ? [...subpath.points, ...subpath.points.slice(0, 1)]
      : subpath.points;
    for (const piece of dash === undefined || solid(dash) ? [line] : dashes(line, dash)) {
      piece.forEach((a, i) => {
        const b = piece[i + 1] ?? a;
        if (i > 0 && b === a) return;
        const left = Math.max(0, Math.floor(Math.min(a.x, b.x) - half - 1));
        const right = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + half + 1));
        const top = Math.max(0, Math.floor(Math.min(a.y, b.y) - half - 1));
        const bottom = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + half + 1));
        for (let y = top; y <= bottom; y++) {
          for (let x = left; x <= right; x++) {
            const d = distanceToSegment({ x: x + 0.5, y: y + 0.5 }, a, b);
            if (d < (nearest[y * width + x] ?? 0)) nearest[y * width + x] = d;
          }
        }
      });
    }
  }
  // A pixel whose center lies on the outline's edge is half covered.
  return nearest.map((d) => Math.min(1, Math.max(0, half + 0.5 - d)));
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether a dash pattern draws a solid line: all its lengths are zero. Throws on a length that cannot be one. */
function solid(dash: readonly [number, number]): boolean {
  if (!dash.every((length) => Number.isFinite(length) && length >= 0)) {
    throw new RangeError(
      `A dash pattern needs finite lengths of at least 0, not ${dash.join(", ")}.`,
    );
  }
  return dash[0] + dash[1] === 0;
}

/**
 * The dashes of a line, alternating `on` long and `off` apart, starting with a
 * dash. A dash of length 0 is a single point, which round caps draw as a dot.
 */
function dashes(
  line: ReadonlyArray<Point>,
  [on, off]: readonly [number, number],
): ReadonlyArray<ReadonlyArray<Point>> {
  const [start] = line;
  if (start === undefined) return [];
  const pieces: Array<ReadonlyArray<Point>> = [];
  let drawing = true;
  let left = on;
  let piece: Array<Point> = [start];
  line.slice(1).forEach((end, i) => {
    let from = line[i] ?? end;
    let rest = Math.hypot(end.x - from.x, end.y - from.y);
    while (rest >= left) {
      const t = rest === 0 ? 0 : left / rest;
      const turn = { x: from.x + (end.x - from.x) * t, y: from.y + (end.y - from.y) * t };
      if (drawing) pieces.push([...piece, turn]);
      piece = [turn];
      drawing = !drawing;
      rest -= left;
      from = turn;
      left = drawing ? on : off;
    }
    left -= rest;
    if (drawing) piece.push(end);
  });
  if (drawing) pieces.push(piece);
  return pieces;
}

export type Rgb = readonly [number, number, number];

/** Whether `n` can be a side of an image: a whole number of px, at least 1. */
export const isPixelCount = (n: number): boolean => Number.isInteger(n) && n >= 1;

/** An image, painted layer by layer over a background color, or over nothing. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  /** Straight (not premultiplied) RGBA, as PNG stores it. */
  readonly pixels: Uint8Array<ArrayBuffer>;

  /**
   * A canvas of `background`, or a clear one without it. Its sides are whole
   * px, at least 1; a `RangeError` says when they are not.
   */
  constructor(width: number, height: number, background?: Rgb) {
    if (!isPixelCount(width) || !isPixelCount(height)) {
      throw new RangeError(
        `A canvas needs sides of a whole number of px, at least 1, not ${width} × ${height}.`,
      );
    }
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    if (background !== undefined) {
      for (let i = 0; i < width * height; i++) this.pixels.set([...background, 255], i * 4);
    }
  }

  /** Fills the subpaths with `color`, blending each edge pixel by how much of it they cover. */
  fill(subpaths: ReadonlyArray<Subpath>, color: Rgb) {
    this.paint(coverage(subpaths, this.width, this.height), color, 1);
  }

  /** Outlines the subpaths in `color`, `lineWidth` wide with round caps and joins. */
  stroke(
    subpaths: ReadonlyArray<Subpath>,
    lineWidth: number,
    color: Rgb,
    options: { readonly opacity?: number; readonly dash?: readonly [number, number] } = {},
  ) {
    const covered = strokeCoverage(subpaths, lineWidth, this.width, this.height, options.dash);
    this.paint(covered, color, options.opacity ?? 1);
  }

  /**
   * Clears what the subpaths cover, as far as they cover each pixel, and with
   * `outline`, a band that wide along their edges too, as a stroke would cover it.
   */
  clear(subpaths: ReadonlyArray<Subpath>, outline?: number) {
    const covered = coverage(subpaths, this.width, this.height);
    if (outline !== undefined) {
      const band = strokeCoverage(subpaths, outline, this.width, this.height);
      for (let i = 0; i < band.length; i++) covered[i] = Math.max(covered[i] ?? 0, band[i] ?? 0);
    }
    for (let i = 0; i < covered.length; i++) {
      const at = i * 4 + 3;
      this.pixels[at] = Math.round((this.pixels[at] ?? 0) * (1 - (covered[i] ?? 0)));
    }
  }

  /** Lays `color` over the image, as much at each pixel as `covered` says, times `opacity`. */
  private paint(covered: Float32Array, color: Rgb, opacity: number) {
    for (let i = 0; i < covered.length; i++) {
      const a = (covered[i] ?? 0) * opacity;
      if (a === 0) continue;
      const below = (this.pixels[i * 4 + 3] ?? 0) / 255;
      // Source over, in straight alpha: over an opaque pixel the total is 1.
      const total = a + below * (1 - a);
      color.forEach((value, channel) => {
        const at = i * 4 + channel;
        this.pixels[at] = Math.round(
          (value * a + (this.pixels[at] ?? 0) * below * (1 - a)) / total,
        );
      });
      this.pixels[i * 4 + 3] = Math.round(total * 255);
    }
  }

  /** The image as a PNG file: 8-bit RGBA, no interlacing. */
  png(): Uint8Array<ArrayBuffer> {
    const stride = this.width * 4;
    // Each scanline is prefixed by its filter type; 0 leaves the bytes as they are.
    const raw = new Uint8Array((stride + 1) * this.height);
    for (let row = 0; row < this.height; row++) {
      raw.set(this.pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, this.width);
    view.setUint32(4, this.height);
    header.set([8, 6, 0, 0, 0], 8);
    return concat([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", zlibSync(raw)),
      chunk("IEND", new Uint8Array(0)),
    ]);
  }
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** CRC-32 as PNG and zlib define it (polynomial 0xedb88320), table-driven. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
