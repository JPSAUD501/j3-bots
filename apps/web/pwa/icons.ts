// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The app's icons, drawn from the same three avatars the first-run and
 * pairing screens show (`Ensemble` in EmptyStates.tsx): a teal hexagon, a
 * violet circle and an orange triangle, each with an idle bot's dot, on the
 * light canvas. No art of its own: change the avatars and the icons follow.
 */
import {
  avatarShapes,
  botPalette,
  colors,
  parseColor,
  toSrgb8,
  type AvatarShapeName,
  type BotColor,
} from "@j3-bots/design-tokens";
import { Canvas, flattenPath, type Point, type Rgb } from "./raster.ts";

interface Member {
  readonly shape: AvatarShapeName;
  readonly color: BotColor;
  /** The avatar's size in the ensemble, in px as EmptyStates.tsx draws it. */
  readonly size: number;
}

const members: ReadonlyArray<Member> = [
  { shape: "hexagon", color: "teal", size: 36 },
  { shape: "circle", color: "violet", size: 48 },
  { shape: "triangle", color: "orange", size: 36 },
];
/** The gap between avatars, in the same px. */
const GAP = 6;
/** An idle bot's dot, in the avatar's 100-unit box (BotAvatar.tsx). */
const DOT_RADIUS = 9;

const rowWidth = members.reduce((total, m) => total + m.size, 0) + GAP * (members.length - 1);
const rowHeight = Math.max(...members.map((m) => m.size));

const srgb = (value: string): Rgb => toSrgb8(parseColor(value));
const hex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/** The light canvas, which the manifest also gives as the splash and theme color. */
export const canvasColor = hex(srgb(colors.background.light));
export const darkCanvasColor = hex(srgb(colors.background.dark));

interface Placed {
  readonly member: Member;
  /** Where the avatar's 100-unit box lands, in ensemble px. */
  readonly left: number;
  readonly top: number;
}

/** Each avatar's place in the row, bottoms aligned as in the ensemble. */
const placed: ReadonlyArray<Placed> = members.map((member, i) => ({
  member,
  left: members.slice(0, i).reduce((total, m) => total + m.size + GAP, 0),
  top: rowHeight - member.size,
}));

function circle(center: Point, radius: number): ReadonlyArray<ReadonlyArray<Point>> {
  const steps = 64;
  return [
    Array.from({ length: steps }, (_, i) => ({
      x: center.x + radius * Math.cos((2 * Math.PI * i) / steps),
      y: center.y + radius * Math.sin((2 * Math.PI * i) / steps),
    })),
  ];
}

/**
 * A square icon of `size` px whose ensemble spans `width` of it, centered.
 * A maskable icon keeps its art within the middle 80% circle, so it asks for
 * less width than one shown as is.
 */
export function iconPng(size: number, width: number): Uint8Array<ArrayBuffer> {
  const canvas = new Canvas(size, size, srgb(colors.background.light));
  const scale = (size * width) / rowWidth;
  const originX = (size - rowWidth * scale) / 2;
  const originY = (size - rowHeight * scale) / 2;
  const ink = srgb(colors["avatar-ink"].light);
  for (const { member, left, top } of placed) {
    const shape = avatarShapes[member.shape];
    const unit = (member.size / 100) * scale;
    const toCanvas = (p: Point): Point => ({
      x: originX + (left + (p.x * member.size) / 100) * scale,
      y: originY + (top + (p.y * member.size) / 100) * scale,
    });
    canvas.fill(
      flattenPath(shape.path).map((ring) => ring.map(toCanvas)),
      srgb(botPalette[member.color].light),
    );
    canvas.fill(circle(toCanvas(shape.mark), DOT_RADIUS * unit), ink);
  }
  return canvas.png();
}

/** The same ensemble as a scalable favicon, on no background. */
export function iconSvg(): string {
  const groups = placed.map(({ member, left, top }) => {
    const shape = avatarShapes[member.shape];
    const k = member.size / 100;
    return `<g transform="translate(${left} ${top}) scale(${k})"><path d="${shape.path}" fill="${hex(srgb(botPalette[member.color].light))}"/><circle cx="${shape.mark.x}" cy="${shape.mark.y}" r="${DOT_RADIUS}" fill="${hex(srgb(colors["avatar-ink"].light))}"/></g>`;
  });
  // A square viewBox, so the browser does not stretch the row to fill the tab.
  const pad = (rowWidth - rowHeight) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${-pad} ${rowWidth} ${rowWidth}">${groups.join("")}</svg>\n`;
}
