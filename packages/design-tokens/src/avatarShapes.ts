// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AvatarShapeName } from "./names.ts";

/**
 * The twelve silhouettes a bot's body can take. Each is SVG path data in the
 * avatar's 100-unit box, in absolute commands only (M, L, C, Q, A, Z), so the
 * PNG renderer draws the same outline the SVG renderers do. A body with its
 * outline stands on the line y = 96, so a pointed body, whose thicker outline
 * reaches further past its path, sits higher; its eye and its antenna's root
 * are where the body is widest and highest. Subpaths of one silhouette all
 * run clockwise, so the nonzero rule fills them as one.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface AvatarShape {
  readonly path: string;
  /** The center of the eye. */
  readonly eye: Point;
  /** Where the antenna leaves the body. */
  readonly antenna: Point;
  /** How much the eye is scaled, for bodies too narrow for the full eye. */
  readonly eyeScale: number;
  /**
   * The width of the outline drawn in the body's color around the fill,
   * which rounds the silhouette's corners. Straight-sided shapes take more.
   */
  readonly outline: number;
}

const shape = (
  path: string,
  eye: readonly [number, number],
  antenna: readonly [number, number],
  { eyeScale = 1, outline = 4 }: { readonly eyeScale?: number; readonly outline?: number } = {},
): AvatarShape => ({
  path,
  eye: { x: eye[0], y: eye[1] },
  antenna: { x: antenna[0], y: antenna[1] },
  eyeScale,
  outline,
});

export const avatarShapes = {
  dome: shape(
    "M18 60A32 32 0 0 1 82 60L82 82A12 12 0 0 1 70 94L30 94A12 12 0 0 1 18 82Z",
    [50, 60],
    [50, 30],
  ),
  block: shape(
    "M38 32L62 32A20 20 0 0 1 82 52L82 74A20 20 0 0 1 62 94L38 94A20 20 0 0 1 18 74L18 52A20 20 0 0 1 38 32Z",
    [50, 62],
    [50, 34],
  ),
  bean: shape(
    "M50 28A24 24 0 0 1 74 52L74 70A24 24 0 0 1 26 70L26 52A24 24 0 0 1 50 28Z",
    [50, 56],
    [50, 30],
    { eyeScale: 0.92 },
  ),
  loaf: shape(
    "M34 44L66 44A22 22 0 0 1 88 66L88 74A20 20 0 0 1 68 94L32 94A20 20 0 0 1 12 74L12 66A22 22 0 0 1 34 44Z",
    [50, 68],
    [50, 46],
  ),
  drop: shape("M50 27C58 39 81 50 81 68A31 26 0 0 1 19 68C19 50 42 39 50 27Z", [50, 66], [50, 34]),
  ears: shape(
    "M50 36A29 29 0 1 1 50 94A29 29 0 1 1 50 36ZM26 31A11 11 0 1 1 26 53A11 11 0 1 1 26 31ZM74 31A11 11 0 1 1 74 53A11 11 0 1 1 74 31Z",
    [50, 66],
    [50, 38],
  ),
  horns: shape(
    "M36 42L64 42A18 18 0 0 1 82 60L82 76A18 18 0 0 1 64 94L36 94A18 18 0 0 1 18 76L18 60A18 18 0 0 1 36 42ZM20 52L23 27L40 44ZM80 52L60 44L77 27Z",
    [50, 66],
    [50, 44],
  ),
  ghost: shape(
    "M18 60A32 32 0 0 1 82 60L82 89Q76.67 96 71.33 89Q66 96 60.66 89Q55.33 96 50 89Q44.67 96 39.33 89Q34 96 28.66 89Q23.33 96 18 89Z",
    [50, 58],
    [50, 30],
  ),
  hex: shape("M50 31.5L76 46.5L76 76.5L50 91.5L24 76.5L24 46.5Z", [50, 61.5], [50, 32.5], {
    outline: 9,
  }),
  gem: shape("M50 31.5L82 61.5L50 91.5L18 61.5Z", [50, 61.5], [50, 33.5], {
    eyeScale: 0.9,
    outline: 9,
  }),
  toes: shape(
    "M18 60A32 32 0 0 1 82 60L82 85A8 8 0 0 1 66 85L58 85A8 8 0 0 1 42 85L34 85A8 8 0 0 1 18 85Z",
    [50, 58],
    [50, 30],
  ),
  pear: shape(
    "M50 30C61 30 68 39 69 49C78 55 84 63 84 74A20 20 0 0 1 64 94L36 94A20 20 0 0 1 16 74C16 63 22 55 31 49C32 39 39 30 50 30Z",
    [50, 68],
    [50, 32],
    { eyeScale: 0.96 },
  ),
} as const satisfies Record<AvatarShapeName, AvatarShape>;
