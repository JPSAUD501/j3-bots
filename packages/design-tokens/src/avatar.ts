// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What an avatar draws over its shape, as data any renderer can draw: the
 * mark that shows the bot's state, the badge for states that concern the
 * operator, and how both grow on small avatars. Coordinates are in the
 * avatar's 100 × 100 box; a mark's are relative to its shape's `mark` point.
 *
 * A still avatar, for notifications and reduced motion, is exactly this: the
 * mark's parts as given, with no motion. Which state shows which mark and
 * motion is the client runtime's decision.
 */
import { avatarShapes, type AvatarShapeName } from "./avatarShapes.ts";
import { botPalette, type BotColor, type ColorRole } from "./tokens.ts";

/** One piece of a mark, drawn in the `avatar-ink` color. */
export type AvatarMarkPart =
  /** A filled disc. */
  | { readonly kind: "disc"; readonly r: number }
  /**
   * A circle's outline. It starts at the circle's right and runs clockwise,
   * so a dash pattern, given as one dash and one gap, starts there.
   */
  | {
      readonly kind: "circle";
      readonly r: number;
      readonly opacity?: number;
      readonly dash?: readonly [number, number];
    }
  /** A path's outline. */
  | { readonly kind: "path"; readonly d: string; readonly join?: "round" };

/** The width of every outline in a mark. Outlines end in round caps. */
export const avatarMarkStroke = 7;

const R = 12;

/** A point on the mark's circle; 0° is the top, angles grow clockwise. */
const at = (degrees: number) => {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return `${(R * Math.cos(rad)).toFixed(2)} ${(R * Math.sin(rad)).toFixed(2)}`;
};

export const avatarMarks = {
  dot: [{ kind: "disc", r: 9 }],
  ring: [{ kind: "circle", r: R }],
  arc: [
    { kind: "circle", r: R, opacity: 0.35 },
    { kind: "path", d: `M${at(-50)}A${R} ${R} 0 0 1 ${at(60)}` },
  ],
  // An open ring, its gap at the top: something is missing, and it is the operator's part.
  // The gap is wide enough that the ring never reads as a power symbol.
  notch: [{ kind: "path", d: `M${at(58)}A${R} ${R} 0 1 1 ${at(-58)}` }],
  slash: [
    { kind: "circle", r: R },
    { kind: "path", d: "M-8.5 8.5L8.5 -8.5" },
  ],
  check: [{ kind: "path", d: "M-10 0.5L-3.5 7L10 -6.5", join: "round" }],
  // Six round dots around the ring: a dash too short to see, then a sixth of the circle.
  dotted: [{ kind: "circle", r: R, dash: [0.01, Math.round((2 * Math.PI * R * 100) / 6) / 100] }],
} as const satisfies Record<string, ReadonlyArray<AvatarMarkPart>>;

export type AvatarMarkName = keyof typeof avatarMarks;

/** Each badge's fill. A badge sits on the avatar's lower right corner. */
export const avatarBadges = {
  waiting: "waiting",
  blocked: "blocked",
  unread: "accent",
} as const satisfies Record<string, ColorRole>;

export type AvatarBadgeName = keyof typeof avatarBadges;

/** The mark and badge an avatar shows. */
export interface AvatarLook {
  readonly mark: AvatarMarkName;
  readonly badge: AvatarBadgeName | null;
}

/** An avatar this size in px or smaller is small. */
const SMALL = 28;

export interface AvatarProportions {
  /** How much the mark is scaled about its point. */
  readonly markScale: number;
  readonly badge: {
    /** The badge's center, on the box's diagonal: both coordinates are this. */
    readonly center: number;
    readonly r: number;
    /**
     * The width of the badge's outline, drawn in the color of what the avatar
     * sits on, so it cuts the badge out of the shape. A still image leaves it clear.
     */
    readonly cutout: number;
  };
}

/** The mark's scale and the badge's place for an avatar `size` px wide: small ones draw both larger, so they stay legible. */
export function avatarProportions(size: number): AvatarProportions {
  const small = size <= SMALL;
  const r = small ? 17 : 14;
  return { markScale: small ? 1.3 : 1, badge: { center: 100 - r + 2, r, cutout: 6 } };
}

const isShape = (token: string): token is AvatarShapeName => Object.hasOwn(avatarShapes, token);
const isColor = (token: string): token is BotColor => Object.hasOwn(botPalette, token);

/**
 * An avatar's tokens as this version of the tokens can draw them. A token
 * this version does not know, from a newer server, falls back instead of failing.
 */
export function resolveAvatar(avatar: { readonly shape: string; readonly color: string }): {
  readonly shape: AvatarShapeName;
  readonly color: BotColor;
} {
  return {
    shape: isShape(avatar.shape) ? avatar.shape : "circle",
    color: isColor(avatar.color) ? avatar.color : "gray",
  };
}
