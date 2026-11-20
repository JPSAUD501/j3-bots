// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Just enough vector rasterizing to turn the avatar shapes into PNG app icons
 * at build time, with no image library: SVG path data in the subset the
 * shapes use (absolute M, L, Q, A and Z), filled with the nonzero rule and
 * anti-aliased, and an RGBA PNG encoder.
 */
import { crc32, deflateSync } from "node:zlib";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A closed outline, as straight segments. */
type Ring = ReadonlyArray<Point>;

/** Segments per curve. Plenty at icon sizes, where a segment spans a few pixels at most. */
const CURVE_STEPS = 32;

/** The path's subpaths, each flattened to a ring of points. */
export function flattenPath(d: string): ReadonlyArray<Ring> {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let index = 0;
  const number = (): number => {
    const token = tokens[index++];
    const value = Number(token);
    if (token === undefined || Number.isNaN(value)) throw new Error(`Expected a number in "${d}".`);
    return value;
  };
  const rings: Array<Array<Point>> = [];
  let ring: Array<Point> = [];
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
        if (ring.length > 0) rings.push(ring);
        current = { x: number(), y: number() };
        ring = [current];
        // Further pairs after a move are lines.
        command = "L";
        break;
      case "L":
        current = { x: number(), y: number() };
        ring.push(current);
        break;
      case "Q": {
        const control = { x: number(), y: number() };
        const end = { x: number(), y: number() };
        const start = current;
        for (let step = 1; step <= CURVE_STEPS; step++) {
          const t = step / CURVE_STEPS;
          const u = 1 - t;
          ring.push({
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
        ring.push(...arcPoints(current, end, rx, ry, rotation, large, sweep));
        current = end;
        break;
      }
      case "Z":
        if (ring.length > 0) rings.push(ring);
        ring = [];
        command = "";
        break;
      default:
        throw new Error(`Unsupported path command "${command}" in "${d}".`);
    }
  }
  if (ring.length > 0) rings.push(ring);
  return rings;
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
 * How much of each pixel of a `width` × `height` image the rings cover, from
 * 0 to 1, filled with the nonzero rule as SVG fills a path by default.
 */
export function coverage(
  rings: ReadonlyArray<Ring>,
  width: number,
  height: number,
): Float32Array<ArrayBuffer> {
  const result = new Float32Array(width * height);
  const edges = rings.flatMap((ring) =>
    ring.map((a, i) => {
      const b = ring[(i + 1) % ring.length] ?? a;
      return { a, b };
    }),
  );
  for (let row = 0; row < height; row++) {
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
  for (let i = 0; i < result.length; i++) result[i] = Math.min(1, (result[i] ?? 0) / SAMPLES);
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

export type Rgb = readonly [number, number, number];

/** An opaque image, painted layer by layer over a background color. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array<ArrayBuffer>;

  constructor(width: number, height: number, background: Rgb) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.pixels.set([...background, 255], i * 4);
  }

  /** Fills the rings with `color`, blending each edge pixel by how much of it they cover. */
  fill(rings: ReadonlyArray<Ring>, color: Rgb) {
    const alpha = coverage(rings, this.width, this.height);
    for (let i = 0; i < alpha.length; i++) {
      const a = alpha[i] ?? 0;
      if (a === 0) continue;
      color.forEach((value, channel) => {
        const at = i * 4 + channel;
        this.pixels[at] = Math.round((this.pixels[at] ?? 0) * (1 - a) + value * a);
      });
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
      chunk("IDAT", new Uint8Array(deflateSync(raw))),
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

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
