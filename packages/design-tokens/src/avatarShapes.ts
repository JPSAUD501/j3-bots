// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Avatar silhouettes, as SVG path data in a 100 × 100 box. A bot's avatar is
 * one of these shapes filled with its palette color, with a single mark inside
 * at `mark`. Ten shapes, so a roster of ten bots can have ten silhouettes.
 */

interface Point {
  readonly x: number;
  readonly y: number;
}

export interface AvatarShape {
  readonly path: string;
  /** Where the inner mark is centered: the shape's visual center. */
  readonly mark: Point;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The item at `index`, counting around the list in either direction. */
function cyclic<T>(items: ReadonlyArray<T>, index: number): T {
  const item = items[((index % items.length) + items.length) % items.length];
  if (item === undefined) throw new Error("A shape needs at least one point.");
  return item;
}
const pt = ({ x, y }: Point) => `${round(x)} ${round(y)}`;

/** A polygon whose corners are rounded with quadratic curves of `radius`. */
function roundedPolygon(points: ReadonlyArray<Point>, radius: number): string {
  const corners = points.map((p, i) => {
    const prev = cyclic(points, i - 1);
    const next = cyclic(points, i + 1);
    const toward = (q: Point) => {
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const r = Math.min(radius, len / 2);
      return { x: p.x + ((q.x - p.x) / len) * r, y: p.y + ((q.y - p.y) / len) * r };
    };
    return { start: toward(prev), corner: p, end: toward(next) };
  });
  const [first] = corners;
  if (first === undefined) return "";
  return `M${pt(first.end)}${corners
    .slice(1)
    .concat(first)
    .map((c) => `L${pt(c.start)}Q${pt(c.corner)} ${pt(c.end)}`)
    .join("")}Z`;
}

function regularPolygon(sides: number, radius: number, rotation: number): Point[] {
  return Array.from({ length: sides }, (_, i) => {
    const angle = rotation + (i * 2 * Math.PI) / sides;
    return { x: 50 + radius * Math.cos(angle), y: 50 + radius * Math.sin(angle) };
  });
}

/**
 * The outline of `lobes` circles of `radius` whose centers sit `distance` from
 * the middle: a clover for few lobes, a scalloped edge for many.
 */
function lobed(lobes: number, distance: number, radius: number, rotation: number): string {
  const centers = regularPolygon(lobes, distance, rotation);
  // Adjacent circles meet on the bisector between their centers; the outline's
  // notch is the intersection farther from the middle.
  const notches = centers.map((c, i) => {
    const d = cyclic(centers, i + 1);
    const mid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
    const half = Math.hypot(d.x - c.x, d.y - c.y) / 2;
    const out = Math.sqrt(radius * radius - half * half);
    const len = Math.hypot(mid.x - 50, mid.y - 50);
    return { x: mid.x + ((mid.x - 50) / len) * out, y: mid.y + ((mid.y - 50) / len) * out };
  });
  const last = cyclic(notches, -1);
  const r = round(radius);
  return `M${pt(last)}${notches.map((p) => `A${r} ${r} 0 1 1 ${pt(p)}`).join("")}Z`;
}

const center = { x: 50, y: 50 };

export const avatarShapes = {
  circle: { path: "M50 4A46 46 0 1 1 50 96A46 46 0 1 1 50 4Z", mark: center },
  square: {
    path: roundedPolygon(
      [
        { x: 7, y: 7 },
        { x: 93, y: 7 },
        { x: 93, y: 93 },
        { x: 7, y: 93 },
      ],
      24,
    ),
    mark: center,
  },
  hexagon: { path: roundedPolygon(regularPolygon(6, 49, -Math.PI / 2), 12), mark: center },
  diamond: {
    path: roundedPolygon(
      [
        { x: 50, y: 1 },
        { x: 99, y: 50 },
        { x: 50, y: 99 },
        { x: 1, y: 50 },
      ],
      14,
    ),
    mark: center,
  },
  triangle: {
    path: roundedPolygon(
      [
        { x: 50, y: 5 },
        { x: 98, y: 90 },
        { x: 2, y: 90 },
      ],
      14,
    ),
    mark: { x: 50, y: 62 },
  },
  clover: { path: lobed(4, 22, 27, -Math.PI / 4), mark: center },
  burst: { path: lobed(10, 38, 12, -Math.PI / 2), mark: center },
  arch: {
    path: "M6 50A44 44 0 0 1 94 50L94 86Q94 94 86 94L14 94Q6 94 6 86Z",
    mark: { x: 50, y: 56 },
  },
  plus: {
    path: roundedPolygon(
      [
        { x: 30, y: 3 },
        { x: 70, y: 3 },
        { x: 70, y: 30 },
        { x: 97, y: 30 },
        { x: 97, y: 70 },
        { x: 70, y: 70 },
        { x: 70, y: 97 },
        { x: 30, y: 97 },
        { x: 30, y: 70 },
        { x: 3, y: 70 },
        { x: 3, y: 30 },
        { x: 30, y: 30 },
      ],
      10,
    ),
    mark: center,
  },
  leaf: {
    path: "M50 5L89 5Q95 5 95 11L95 50A45 45 0 0 1 50 95L11 95Q5 95 5 89L5 50A45 45 0 0 1 50 5Z",
    mark: center,
  },
} as const satisfies Record<string, AvatarShape>;

export type AvatarShapeName = keyof typeof avatarShapes;

export const avatarShapeNames = Object.keys(avatarShapes) as ReadonlyArray<AvatarShapeName>;
