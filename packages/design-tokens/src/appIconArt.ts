// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The art of the app's icons, the tray's and the favicon's: one Pip, an
 * avatar in a pose of its own, framed on a plate. Every platform's icon is
 * drawn from it (`raster/appIcon.ts`), so the icon changes here and nowhere
 * else.
 */
import type { AvatarFace } from "./avatar.ts";
import type { AvatarShapeName, BotColor } from "./names.ts";
import type { Themed } from "./tokens.ts";

/** A square of the avatar's 100-unit box: its top left corner and its side. */
export interface IconFrame {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface IconArt {
  readonly avatar: { readonly shape: AvatarShapeName; readonly color: BotColor };
  /** The palette the Pip is drawn in on the plate. */
  readonly palette: keyof Themed;
  /** The plate under it, as `#rrggbb`: the same in every theme, as an icon is. */
  readonly plate: string;
  /** The pose it holds. */
  readonly face: AvatarFace;
  /**
   * The square of the avatar's box a plate shows: the Pip whole, or a crop of
   * it that the plate's edges cut.
   */
  readonly frame: IconFrame;
  /**
   * The square that holds the Pip whole, where it stands without a plate: a
   * notification's icon, the tray, the splash screen, a themed icon.
   */
  readonly whole: IconFrame;
}

/** An idle Pip at rest, looking straight out. */
const rest: AvatarFace = {
  lidTop: 0,
  lidBottom: 0,
  blink: 0,
  pupil: 6.8,
  gazeX: 0,
  gazeY: 0,
  shut: 0,
  curve: 0,
  roll: 0,
  cheek: 0,
  eyeLift: 0,
  mouth: 0,
  antennaAngle: 0,
  antennaLength: 17,
  lagX: 0,
  lagY: 0,
  lightScale: 1,
  light: "body",
  hop: 0,
  bob: 0,
  tilt: 0,
  breath: 0,
  squash: 0,
  signal: null,
  ring: 0,
  ping: 0,
  pingOpacity: 0,
  arcs: [1, 1],
  dots: [1, 1],
  asleep: false,
};

/**
 * The icon every platform shows: an iris loaf seen close, on a true-black
 * plate. The plate frames its eye, lifted and a little wide, and its antenna;
 * the body rises off the plate's bottom edge.
 */
export const iconArt: IconArt = {
  avatar: { shape: "loaf", color: "iris" },
  palette: "dark",
  plate: "#000000",
  face: { ...rest, pupil: 7.4, eyeLift: -7 },
  frame: { x: 21, y: 19, size: 58 },
  whole: { x: 4, y: 4, size: 92 },
};
