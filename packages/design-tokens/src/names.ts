// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The names of the avatar tokens, apart from how they look, so the contract
 * and the server can name them without loading shapes or colors. The shapes
 * (`avatarShapes`) and the palette (`botPalette`) have one entry per name.
 */

/** The avatar shapes, in the order a gallery lists them. */
export const avatarShapeNames = [
  "circle",
  "square",
  "hexagon",
  "diamond",
  "triangle",
  "clover",
  "burst",
  "arch",
  "plus",
  "leaf",
] as const;

export type AvatarShapeName = (typeof avatarShapeNames)[number];

/** The bot colors that have a hue: every color but gray. */
export const botHues = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;

/** Every bot color. Gray is also what a client draws for a color it does not know (`resolveAvatar`). */
export const botColors = [...botHues, "gray"] as const;

export type BotColor = (typeof botColors)[number];
